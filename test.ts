import { createApp } from './app.ts';
import { store } from './store.ts';
import assert from 'node:assert';

function pktLine(str: string): Buffer {
  const len = Buffer.byteLength(str) + 4;
  const lenHex = len.toString(16).padStart(4, '0');
  return Buffer.from(lenHex + str);
}

async function runTests() {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  const baseUrl = `http://localhost:${port}`;

  console.log(`Test server running at ${baseUrl}`);

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.deepStrictEqual(healthJson, { ok: true });
    console.log('✓ /healthz passed');

    // 2. REST API root
    const rootRes = await fetch(`${baseUrl}/api/v3`);
    assert.strictEqual(rootRes.status, 200);
    assert.ok(rootRes.headers.get('x-github-request-id'));
    assert.strictEqual(rootRes.headers.get('x-oauth-scopes'), 'repo, read:org');
    console.log('✓ /api/v3 passed');

    // 3. Create repo via REST
    const createRes = await fetch(`${baseUrl}/api/v3/user/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smart-test-repo', description: 'Smart HTTP test repository' }),
    });
    assert.strictEqual(createRes.status, 201);
    const repoJson = await createRes.json() as any;
    assert.strictEqual(repoJson.name, 'smart-test-repo');
    assert.strictEqual(repoJson.full_name, 'testuser/smart-test-repo');
    console.log('✓ POST /api/v3/user/repos passed');

    // 4. Seed git objects and refs
    const fileContent = 'Hello from smart HTTP test!\n';
    const blobSha = store.storeObject('blob', Buffer.from(fileContent, 'utf8'));

    const shaBinary = Buffer.from(blobSha, 'hex');
    const treeEntry = Buffer.concat([
      Buffer.from('100644 file.txt\0', 'utf8'),
      shaBinary
    ]);
    const treeSha = store.storeObject('tree', treeEntry);

    const commitContent = Buffer.from(
      `tree ${treeSha}\nauthor Test User <test@example.com> 1700000000 +0000\ncommitter Test User <test@example.com> 1700000000 +0000\n\nSmart HTTP commit\n`,
      'utf8'
    );
    const commitSha = store.storeObject('commit', commitContent);

    store.setRef('testuser', 'smart-test-repo', 'refs/heads/main', commitSha);
    console.log(`✓ Seeded git commit ${commitSha}`);

    // 5. Test GET info/refs with Git-Protocol: version=2
    const infoRes = await fetch(`${baseUrl}/testuser/smart-test-repo.git/info/refs?service=git-upload-pack`, {
      headers: { 'git-protocol': 'version=2' }
    });
    assert.strictEqual(infoRes.status, 200);
    const infoText = await infoRes.text();
    assert.ok(infoText.includes('# service=git-upload-pack'));
    assert.ok(infoText.includes('version 2'));
    console.log('✓ GET info/refs (v2) passed');

    // 6. Test POST git-upload-pack protocol v2 (ls-refs)
    const lsRefsBody = Buffer.concat([
      pktLine('command=ls-refs\n'),
      pktLine('ref-prefix refs/heads/\n'),
      Buffer.from('0000')
    ]);
    const lsRefsRes = await fetch(`${baseUrl}/testuser/smart-test-repo.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'git-protocol': 'version=2',
        'content-type': 'application/x-git-upload-pack-request'
      },
      body: lsRefsBody
    });
    assert.strictEqual(lsRefsRes.status, 200);
    const lsRefsText = await lsRefsRes.text();
    assert.ok(lsRefsText.includes(commitSha));
    assert.ok(lsRefsText.includes('refs/heads/main'));
    console.log('✓ POST git-upload-pack (ls-refs) passed');

    // 7. Test POST git-upload-pack protocol v2 (fetch)
    const fetchBody = Buffer.concat([
      pktLine('command=fetch\n'),
      pktLine(`want ${commitSha}\n`),
      pktLine('done\n'),
      Buffer.from('0000')
    ]);
    const fetchRes = await fetch(`${baseUrl}/testuser/smart-test-repo.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'git-protocol': 'version=2',
        'content-type': 'application/x-git-upload-pack-request'
      },
      body: fetchBody
    });
    assert.strictEqual(fetchRes.status, 200);
    const fetchBuffer = Buffer.from(await fetchRes.arrayBuffer());
    assert.ok(fetchBuffer.length > 0);
    // Verify pack header 'PACK' is present in response
    assert.ok(fetchBuffer.includes(Buffer.from('PACK')));
    console.log('✓ POST git-upload-pack (fetch & packfile) passed');

    // 8. Delete repo via REST
    const deleteRes = await fetch(`${baseUrl}/api/v3/repos/testuser/smart-test-repo`, {
      method: 'DELETE',
    });
    assert.strictEqual(deleteRes.status, 204);
    console.log('✓ DELETE repo passed');

    console.log('ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
