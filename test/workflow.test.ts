import { chmod, mkdtemp, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { checkout, TaskStore, type Task } from '../src/store.ts'
import { createSessionCheckoutApplyEngine, runGit } from '../src/engine.ts'

const git = async (cwd: string, ...args: string[]) => (await runGit(cwd, args)).stdout.toString()
const content = async (cwd: string, file: string) => readFile(join(cwd, file), 'utf8')
const exists = (path: string) => stat(path).then(() => true, () => false)

async function fixture(t: TestContext, engine?: typeof createSessionCheckoutApplyEngine, empty = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-wtp-test-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const local = join(dir, 'Local with spaces')
  await mkdir(local)
  await git(local, 'init', '-b', 'main')
  await git(local, 'config', 'user.name', 'Test')
  await git(local, 'config', 'user.email', 'test@localhost')
  if (!empty) {
    for (const file of ['task.txt', 'staged.txt', 'unstaged.txt']) await writeFile(join(local, file), `${file} base\n`)
    await writeFile(join(local, '.gitignore'), 'cache/\n')
    await git(local, 'add', '.')
  }
  await git(local, 'commit', '--allow-empty', '-m', 'base')
  // Git versions that materialize an empty index on commit need this to
  // reproduce repositories where no index file was ever written.
  if (empty) await rm(join(local, '.git/index'), { force: true })
  const base = await git(local, 'rev-parse', 'HEAD')
  const store = new TaskStore(join(dir, 'state'), engine)
  const task = await store.create(await checkout(local), { cwd: local, id: 'local', file: join(dir, 'local.jsonl') },
    async cwd => ({ cwd, id: 'isolated', file: join(dir, 'isolated.jsonl') }))
  const isolated = task.isolatedPath
  const latest = async () => (await store.read()).tasks[0]
  const act = async (action: Parameters<TaskStore['act']>[1], current: Task) => store.act(task.id, action, {
    phase: current.phase, reviewId: current.review?.id, previewId: current.receipt?.previewId,
    discardFingerprint: action === 'discard' ? await store.discardFingerprint(current) : undefined,
  })
  const ready = () => store.markReady(task.id, task.isolatedSession!, 'Task only')
  return { dir, local, isolated, store, base, latest, act, ready, task }
}

test('journaled preview, rollback, re-preview and task-only commit preserve Local layers', async t => {
  const { local, isolated, store, base, latest, act, ready } = await fixture(t)
  await writeFile(join(local, 'staged.txt'), 'staged content\n')
  await git(local, 'add', 'staged.txt')
  await writeFile(join(local, 'staged.txt'), 'working over staged\n')
  await writeFile(join(local, 'unstaged.txt'), 'unstaged content\n')
  await writeFile(join(local, 'user.txt'), 'untracked content\n')
  await writeFile(join(isolated, 'task.txt'), 'task change\n')
  await writeFile(join(isolated, 'bin.dat'), Buffer.from([0, 1, 0xff, 0x80]))
  await git(isolated, 'add', 'bin.dat')
  await git(isolated, 'commit', '-m', 'isolated commit')
  const status = await git(local, 'status', '--porcelain=v1')
  const staged = await git(local, 'diff', '--cached')
  const unstaged = await git(local, 'diff')
  await ready()
  assert.equal(await git(local, 'status', '--porcelain=v1'), status)
  const preview = await act('preview', await latest())
  assert.equal(preview.phase, 'previewed')
  assert.equal(await git(local, 'rev-parse', 'HEAD'), base)
  assert.equal(await git(local, 'diff', '--cached'), staged)
  assert.equal(await content(local, 'task.txt'), 'task change\n')
  assert.deepEqual(await readFile(join(local, 'bin.dat')), Buffer.from([0, 1, 0xff, 0x80]))
  assert.match(await git(local, 'for-each-ref', 'refs/pi-worktree-preview'), /snapshot-0/)
  await act('rollback', await latest())
  assert.equal(await git(local, 'status', '--porcelain=v1'), status)
  assert.equal(await git(local, 'diff'), unstaged)
  assert.equal(await git(local, 'diff', '--cached'), staged)
  assert.equal(await exists(join(local, 'bin.dat')), false)
  await act('preview', await latest())
  const delivered = await act('finalize', await latest())
  assert.equal(delivered.phase, 'delivered')
  assert.equal(delivered.cleanup?.status, 'done')
  assert.equal(await exists(isolated), false)
  assert.equal(await git(local, 'show', '-s', '--format=%s'), 'Task only\n')
  assert.equal(await git(local, 'show', '--format=', '--name-only'), 'bin.dat\ntask.txt\n')
  assert.equal(await git(local, 'diff', '--cached'), staged)
  assert.equal(await git(local, 'diff'), unstaged)
  assert.equal(await content(local, 'user.txt'), 'untracked content\n')
  assert.equal(await exists(store.lockPath), false)
})

test('conflict and stale ready snapshot do not change Local', async t => {
  const { local, isolated, latest, act, ready } = await fixture(t)
  await writeFile(join(isolated, 'task.txt'), 'task edit\n')
  await ready()
  await writeFile(join(isolated, 'task.txt'), 'later task edit\n')
  await writeFile(join(local, 'task.txt'), 'my edit\n')
  await assert.rejects(act('preview', await latest()), /待验收文件已变化.*task.txt/)
  await ready()
  await assert.rejects(act('preview', await latest()), /预览冲突/)
  assert.equal(await content(local, 'task.txt'), 'my edit\n')
  assert.equal((await latest()).journal, undefined)
})

test('only frozen review paths reach Local; later ancillary edits and commits are kept', async t => {
  const f = await fixture(t)
  await writeFile(join(f.isolated, 'task.txt'), 'task only\n')
  assert.deepEqual((await f.ready()).files, ['task.txt'])
  await writeFile(join(f.local, 'staged.txt'), 'my staged\n')
  await git(f.local, 'add', 'staged.txt')
  for (const [root, bytes] of [[f.local, 'Local loops\n'], [f.isolated, 'isolated loops\n']]) {
    await mkdir(join(root, '.pi'))
    await writeFile(join(root, '.pi/loops.json'), bytes)
  }
  await writeFile(join(f.isolated, 'unstaged.txt'), 'unrelated isolated commit\n')
  await git(f.isolated, 'add', 'unstaged.txt')
  await git(f.isolated, 'commit', '-m', 'late ancillary commit')
  await f.act('preview', await f.latest())
  assert.equal(await content(f.local, 'task.txt'), 'task only\n')
  assert.equal(await content(f.local, '.pi/loops.json'), 'Local loops\n')
  assert.equal(await content(f.local, 'unstaged.txt'), 'unstaged.txt base\n')
  await f.act('rollback', await f.latest())
  assert.equal(await content(f.local, 'task.txt'), 'task.txt base\n')
  await f.act('preview', await f.latest())
  const done = await f.act('finalize', await f.latest())
  assert.equal(done.cleanup?.status, 'retained')
  assert.equal(await content(f.isolated, '.pi/loops.json'), 'isolated loops\n')
  assert.equal(await content(f.isolated, 'unstaged.txt'), 'unrelated isolated commit\n')
  assert.equal(await git(f.local, 'show', '--format=', '--name-only'), 'task.txt\n')
  assert.equal(await git(f.local, 'diff', '--cached', '--name-only'), 'staged.txt\n')
})

test('legacy review with later unrelated untracked file migrates only from a matching fingerprint', async t => {
  const f = await fixture(t)
  await writeFile(join(f.isolated, 'task.txt'), 'reviewed\n')
  await f.ready()
  const state = await f.store.read()
  delete state.tasks[0].review?.snapshot
  await writeFile(f.store.statePath, JSON.stringify(state))
  await writeFile(join(f.isolated, 'other.txt'), 'late\n')
  await writeFile(join(f.isolated, 'task.txt'), 'changed\n')
  await assert.rejects(f.act('preview', await f.latest()), /无法核验此前的待验收记录/)
  await writeFile(join(f.isolated, 'task.txt'), 'reviewed\n')
  await f.act('preview', await f.latest())
  assert.equal(await content(f.local, 'task.txt'), 'reviewed\n')
  assert.equal(await exists(join(f.local, 'other.txt')), false)
})

test('staged-only drift and last-minute reviewed-path drift fail before touching Local', async t => {
  let changeReviewed = true
  const f = await fixture(t, () => createSessionCheckoutApplyEngine({ beforeFinalLocalValidation: async () => {
    assert.equal((await f.latest()).journal?.operation, 'preview')
    if (changeReviewed) await writeFile(join(f.isolated, 'task.txt'), 'after journal\n')
    else await writeFile(join(f.isolated, 'other.txt'), 'after journal, unrelated\n')
  } }))
  await writeFile(join(f.isolated, 'task.txt'), 'reviewed\n')
  await f.ready()
  await git(f.isolated, 'add', 'task.txt')
  await assert.rejects(f.act('preview', await f.latest()), /待验收文件已变化/)
  await git(f.isolated, 'reset', '--', 'task.txt')
  await assert.rejects(f.act('preview', await f.latest()), /待验收文件已变化/)
  assert.equal((await f.latest()).journal, undefined)
  assert.equal(await content(f.local, 'task.txt'), 'task.txt base\n')
  changeReviewed = false
  await f.ready()
  await f.act('preview', await f.latest())
  assert.equal(await content(f.local, 'task.txt'), 'after journal\n')
  assert.equal(await exists(join(f.local, 'other.txt')), false)
})

test('the frozen manifest handles a reviewed deletion, nested addition, symlink and executable mode', async t => {
  const f = await fixture(t)
  await rm(join(f.isolated, 'task.txt'))
  await mkdir(join(f.isolated, 'task.txt'))
  await symlink('../staged.txt', join(f.isolated, 'task.txt/link'))
  await chmod(join(f.isolated, 'staged.txt'), 0o755)
  assert.deepEqual((await f.ready()).files, ['staged.txt', 'task.txt', 'task.txt/link'])
  await chmod(join(f.isolated, 'staged.txt'), 0o644)
  await assert.rejects(f.act('preview', await f.latest()), /待验收文件已变化.*staged.txt/)
  await chmod(join(f.isolated, 'staged.txt'), 0o755)
  await f.act('preview', await f.latest())
  assert.equal(await readlink(join(f.local, 'task.txt/link')), '../staged.txt')
  assert.equal((await stat(join(f.local, 'staged.txt'))).mode & 0o100, 0o100)
  await f.act('rollback', await f.latest())
  assert.equal(await content(f.local, 'task.txt'), 'task.txt base\n')
  assert.equal((await stat(join(f.local, 'staged.txt'))).mode & 0o100, 0)
})

test('ignored Local obstructions are rejected before any preview write', async t => {
  const f = await fixture(t)
  await writeFile(join(f.isolated, 'task.txt'), 'task change\n')
  await writeFile(join(f.isolated, 'obstruction'), 'new file\n')
  await mkdir(join(f.local, 'obstruction'))
  await writeFile(join(f.local, 'obstruction/private'), 'do not touch\n')
  await writeFile(join(f.task.local.gitDir, 'info/exclude'), '/obstruction/private\n')
  await f.ready()
  await assert.rejects(f.act('preview', await f.latest()), /Local 路径与预览改动冲突/)
  assert.equal(await content(f.local, 'task.txt'), 'task.txt base\n')
  assert.equal(await content(f.local, 'obstruction/private'), 'do not touch\n')
  assert.equal((await f.latest()).journal, undefined)
})

test('both post-preview actions fail closed on drift, including unrelated staged edits', async t => {
  const { local, isolated, latest, act, ready, base } = await fixture(t)
  await writeFile(join(isolated, 'task.txt'), 'task edit\n')
  await ready()
  await act('preview', await latest())
  await writeFile(join(local, 'staged.txt'), 'later staged\n')
  await git(local, 'add', 'staged.txt')
  await assert.rejects(act('rollback', await latest()), /自预览后已变化/)
  await assert.rejects(act('finalize', await latest()), /自预览后已变化/)
  assert.equal(await content(local, 'task.txt'), 'task edit\n')
  assert.equal(await git(local, 'rev-parse', 'HEAD'), base)
  assert.equal((await latest()).phase, 'previewed')
})

test('durable pending write is seen before final revalidation and blocks auto-replay', async t => {
  let seen: Task | undefined
  const f = await fixture(t, () => createSessionCheckoutApplyEngine({ beforeFinalLocalValidation: async () => {
    seen = await f.latest()
    await writeFile(join(f.local, 'task.txt'), 'external edit before write\n')
  } }))
  await writeFile(join(f.isolated, 'task.txt'), 'task edit\n')
  await f.ready()
  await assert.rejects(f.act('preview', await f.latest()), /恢复记录/)
  assert.equal(seen?.journal?.operation, 'preview')
  assert.ok(seen?.receipt?.localWorkingTreeOid)
  assert.equal(await content(f.local, 'task.txt'), 'external edit before write\n')
  const reopened = new TaskStore(f.store.directory)
  const blocked = (await reopened.read()).tasks[0]
  await assert.rejects(reopened.act(blocked.id, 'preview', { phase: 'ready', reviewId: blocked.review?.id }), /恢复记录/)
})

test('nested patch paths cannot alias a root path even with diff.noPrefix', async t => {
  const f = await fixture(t)
  await git(f.local, 'config', 'diff.noPrefix', 'true')
  await mkdir(join(f.isolated, 'sub'))
  await writeFile(join(f.isolated, 'sub/task.txt'), 'task.txt base\n')
  await f.ready()
  await f.act('preview', await f.latest())
  await f.act('rollback', await f.latest())
  assert.equal(await content(f.local, 'task.txt'), 'task.txt base\n')
  assert.equal(await exists(join(f.local, 'sub/task.txt')), false)
})

test('unsupported merge attributes and intent-to-add cannot bypass snapshot validation', async t => {
  const f = await fixture(t)
  await writeFile(join(f.isolated, '.gitattributes'), 'task.txt merge=union\n')
  await writeFile(join(f.isolated, 'task.txt'), 'task edit\n')
  await assert.rejects(f.ready(), /Git 属性：merge/)
  await rm(join(f.isolated, '.gitattributes'))
  await f.ready()
  await writeFile(join(f.local, 'intent.txt'), 'planned\n')
  await git(f.local, 'add', '-N', 'intent.txt')
  const before = await git(f.local, 'status', '--porcelain')
  await assert.rejects(f.act('preview', await f.latest()), /intent-to-add/)
  assert.equal(await git(f.local, 'status', '--porcelain'), before)
  assert.equal(await content(f.local, 'task.txt'), 'task.txt base\n')
})

test('finalize journals both index images before the ref/index CAS and retains them on uncertainty', async t => {
  let failWrite = false
  let saved: Task | undefined
  const f = await fixture(t, () => createSessionCheckoutApplyEngine({ afterLocalWriteBeforeVerification: async () => {
    if (!failWrite) return
    saved = await f.latest()
    await writeFile(join(f.local, 'staged.txt'), 'concurrent user edit\n')
    await git(f.local, 'add', 'staged.txt')
  } }))
  await writeFile(join(f.isolated, 'task.txt'), 'task edit\n')
  await f.ready()
  await f.act('preview', await f.latest())
  failWrite = true
  await assert.rejects(f.act('finalize', await f.latest()), /恢复记录/)
  assert.equal(saved?.journal?.operation, 'finalize')
  assert.ok(saved?.journal?.indexBefore && await exists(saved.journal.indexBefore))
  assert.ok(saved?.journal?.indexAfter && await exists(saved.journal.indexAfter))
  assert.equal(await content(f.local, 'staged.txt'), 'concurrent user edit\n')
  assert.match(await git(f.local, 'diff', '--cached'), /concurrent user edit/)
  assert.equal(await exists(f.isolated), true)
})

test('finalize from an empty commit without an index commits only the task', async t => {
  const f = await fixture(t, undefined, true)
  const index = join(f.task.local.gitDir, 'index')
  await writeFile(join(f.isolated, 'README.md'), 'new readme\n')
  await writeFile(join(f.local, 'private.txt'), 'Local only\n')
  await f.ready()
  await f.act('preview', await f.latest())
  assert.equal(await exists(index), false)
  const delivered = await f.act('finalize', await f.latest())
  assert.equal(delivered.phase, 'delivered')
  assert.equal(await git(f.local, 'rev-parse', 'HEAD^'), f.base)
  assert.equal(await git(f.local, 'show', '--format=', '--name-only'), 'README.md\n')
  assert.equal(await git(f.local, 'status', '--porcelain'), '?? private.txt\n')
  assert.equal(await exists(index), true)
})

test('finalize compensates to an absent index after a post-write error', async t => {
  let fail = false
  const f = await fixture(t, () => createSessionCheckoutApplyEngine({ afterLocalWriteBeforeVerification: async () => {
    if (!fail) return
    const journal = (await f.latest()).journal
    assert.equal(journal?.operation, 'finalize')
    assert.equal(journal?.indexBefore, null)
    assert.ok(journal?.indexAfter && await exists(journal.indexAfter))
    assert.equal(await exists(join(f.task.local.gitDir, 'index')), true)
    throw new Error('simulated post-write failure')
  } }), true)
  await writeFile(join(f.isolated, 'README.md'), 'previewed readme\n')
  await f.ready()
  await f.act('preview', await f.latest())
  fail = true
  await assert.rejects(f.act('finalize', await f.latest()), /simulated post-write failure/)
  assert.equal(await git(f.local, 'rev-parse', 'HEAD'), f.base)
  assert.equal(await content(f.local, 'README.md'), 'previewed readme\n')
  assert.equal(await exists(join(f.task.local.gitDir, 'index')), false)
  assert.equal(await exists(join(f.task.local.gitDir, 'index.lock')), false)
})

test('finalize detects an index created after journaling even when it is logically empty', async t => {
  let createIndex = false
  const f = await fixture(t, () => createSessionCheckoutApplyEngine({ beforeFinalLocalValidation: async () => {
    if (!createIndex) return
    assert.equal((await f.latest()).journal?.indexBefore, null)
    await git(f.local, 'read-tree', '--empty')
  } }), true)
  const index = join(f.task.local.gitDir, 'index')
  await writeFile(join(f.isolated, 'README.md'), 'previewed readme\n')
  await f.ready()
  await f.act('preview', await f.latest())
  assert.equal(await exists(index), false)
  createIndex = true
  await assert.rejects(f.act('finalize', await f.latest()), /恢复记录/)
  assert.equal(await git(f.local, 'rev-parse', 'HEAD'), f.base)
  assert.equal(await git(f.local, 'ls-files'), '')
  assert.equal(await exists(index), true)
  assert.equal(await content(f.local, 'README.md'), 'previewed readme\n')
})

test('discard removes a verified dirty worktree but preserves ignored data', async t => {
  const f = await fixture(t)
  await writeFile(join(f.isolated, 'task.txt'), 'discard me\n')
  const discarded = await f.act('discard', await f.latest())
  assert.equal(discarded.cleanup?.status, 'done')
  assert.equal(await exists(f.isolated), false)
  assert.equal(await git(f.local, 'rev-parse', 'HEAD'), f.base)
  const second = await fixture(t)
  await mkdir(join(second.isolated, 'cache'))
  await writeFile(join(second.isolated, 'cache', 'private'), 'preserve me')
  const retained = await second.act('discard', await second.latest())
  assert.equal(retained.phase, 'discarded')
  assert.equal(retained.cleanup?.status, 'retained')
  assert.equal(await content(second.isolated, 'cache/private'), 'preserve me')
})
