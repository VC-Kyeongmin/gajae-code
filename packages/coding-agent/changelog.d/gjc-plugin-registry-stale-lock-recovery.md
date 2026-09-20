### Fixed

- GJC sessions no longer crash on a plugin `registry.lock` left behind by a dead writer: lock acquisition now probes the holder PID recorded in the (now host-tagged) lock token and evicts provably stale locks. Legacy `pid-nonce` tokens additionally require the lock to be aged past two acquire windows; live or foreign-host holders still fail closed.
- A registry lock held by a concurrent install no longer fails session startup: `readRegistry` degrades to its already-computed in-memory migration result and leaves persistence to a later uncontended session. Install/mutate paths keep the fail-loud `install_conflict` error.
