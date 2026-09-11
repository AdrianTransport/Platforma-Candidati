import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Înlocuirea fotografiei vizează doar profilul și imaginea aprobate, persistă și respectă editările ulterioare', async () => {
  const originalCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-image-update-'));
  const oldImage = '/media/fefd679d-edd5-4b3c-9cd2-20eb1e7613c1';
  const newImage = '/candidate-assets/daniel-ganea-portrait-transparent-v1.webp';
  try {
    process.chdir(dir);
    const { db, initDB } = await import('../db.js');
    await fs.mkdir('data');
    await fs.writeFile('data/db.json', JSON.stringify({ users: [
      { id: 1, role: 'admin' },
      { id: 2, role: 'candidate', subdomeniu: 'daniel-ganea', fotografie_profil_url: oldImage,
        fotografie_coperta_url: 'https://example.test/cover.png', activ: true,
        status_cont: 'activ', vizibil_in_portal: false, module: { site: true } },
      { id: 3, role: 'candidate', subdomeniu: 'alt-candidat', fotografie_profil_url: oldImage }
    ] }));
    await initDB();
    assert.equal(db.data.users[1].fotografie_profil_url, newImage);
    assert.equal(db.data.users[1].fotografie_coperta_url, 'https://example.test/cover.png');
    assert.equal(db.data.users[1].vizibil_in_portal, false);
    assert.equal(db.data.users[2].fotografie_profil_url, oldImage);
    assert.equal(JSON.parse(await fs.readFile('data/db.json', 'utf8')).users[1].fotografie_profil_url, newImage);
    await initDB();
    assert.equal(db.data.users[1].fotografie_profil_url, newImage);
    for (const priorImage of ['https://vocealenauheim.ro/candidate-assets/daniel-ganea-20260911.png', '/candidate-assets/daniel-ganea-20260911-v1.webp']) {
      db.data.users[1].fotografie_profil_url = priorImage;
      await db.write();
      await initDB();
      assert.equal(db.data.users[1].fotografie_profil_url, newImage);
      assert.equal(db.data.users[2].fotografie_profil_url, oldImage);
    }
    for (const laterImage of ['https://example.test/replacement.png', '']) {
      db.data.users[1].fotografie_profil_url = laterImage;
      await db.write();
      await initDB();
      assert.equal(db.data.users[1].fotografie_profil_url, laterImage);
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
