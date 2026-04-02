/**
 * MnemoPayLite — Browser build (score-based recall, zero dependencies)
 * Extracted from @mnemopay/sdk v0.1.1
 *
 * This is the same logic that runs in the npm package,
 * bundled as a single ES module for browser use.
 */

// ── Auto-scoring keywords ──────────────────────────────────────────────

const IMPORTANCE_PATTERNS = [
  { pattern: /\b(error|fail|crash|critical|broken|bug)\b/i, boost: 0.20 },
  { pattern: /\b(success|complete|paid|delivered|resolved)\b/i, boost: 0.15 },
  { pattern: /\b(prefer|always|never|important|must|require)\b/i, boost: 0.15 },
];

const LONG_CONTENT_THRESHOLD = 200;
const LONG_CONTENT_BOOST = 0.10;
const BASE_IMPORTANCE = 0.50;

function autoScore(content) {
  let score = BASE_IMPORTANCE;
  if (content.length > LONG_CONTENT_THRESHOLD) score += LONG_CONTENT_BOOST;
  for (const { pattern, boost } of IMPORTANCE_PATTERNS) {
    if (pattern.test(content)) score += boost;
  }
  return Math.min(score, 1.0);
}

// ── Memory scoring ─────────────────────────────────────────────────────

function computeScore(importance, lastAccessed, accessCount, decay) {
  const hoursSince = (Date.now() - lastAccessed.getTime()) / 3_600_000;
  const recency = Math.exp(-decay * hoursSince);
  const frequency = 1 + Math.log(1 + accessCount);
  return importance * recency * frequency;
}

// ── MnemoPayLite ───────────────────────────────────────────────────────

export class MnemoPayLite {
  constructor(agentId, decay = 0.05) {
    this.agentId = agentId;
    this.decay = decay;
    this.memories = new Map();
    this.transactions = new Map();
    this.auditLog = [];
    this._wallet = 0;
    this._reputation = 0.5;
    this._listeners = {};
  }

  // Simple event emitter
  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return this;
  }

  emit(event, ...args) {
    (this._listeners[event] || []).forEach(fn => fn(...args));
  }

  _audit(action, details) {
    this.auditLog.push({
      id: crypto.randomUUID(),
      agentId: this.agentId,
      action,
      details,
      createdAt: new Date(),
    });
  }

  // ── Memory Methods ─────────────────────────────────────────────────

  async remember(content, opts = {}) {
    const importance = opts.importance ?? autoScore(content);
    const now = new Date();
    const mem = {
      id: crypto.randomUUID(),
      agentId: this.agentId,
      content,
      importance: Math.min(Math.max(importance, 0), 1),
      score: importance,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      tags: opts.tags || [],
    };
    this.memories.set(mem.id, mem);
    this._audit("memory:stored", { id: mem.id, content: content.slice(0, 100), importance: mem.importance });
    this.emit("memory:stored", { id: mem.id, content, importance: mem.importance });
    return mem.id;
  }

  async recall(queryOrLimit, maybeLimit) {
    const limit = typeof queryOrLimit === "number" ? queryOrLimit : (maybeLimit ?? 5);
    const all = Array.from(this.memories.values()).map((m) => {
      m.score = computeScore(m.importance, m.lastAccessed, m.accessCount, this.decay);
      return m;
    });
    all.sort((a, b) => b.score - a.score);
    const results = all.slice(0, limit);
    const now = new Date();
    for (const m of results) {
      m.lastAccessed = now;
      m.accessCount++;
    }
    this.emit("memory:recalled", { count: results.length });
    return results;
  }

  async forget(id) {
    const existed = this.memories.delete(id);
    if (existed) this._audit("memory:deleted", { id });
    return existed;
  }

  async reinforce(id, boost = 0.1) {
    const mem = this.memories.get(id);
    if (!mem) throw new Error(`Memory ${id} not found`);
    mem.importance = Math.min(mem.importance + boost, 1.0);
    mem.lastAccessed = new Date();
    this._audit("memory:reinforced", { id, boost, newImportance: mem.importance });
  }

  async consolidate() {
    const threshold = 0.01;
    let pruned = 0;
    for (const [id, mem] of this.memories) {
      const score = computeScore(mem.importance, mem.lastAccessed, mem.accessCount, this.decay);
      if (score < threshold) {
        this.memories.delete(id);
        pruned++;
      }
    }
    this._audit("memory:consolidated", { pruned });
    return pruned;
  }

  // ── Payment Methods ────────────────────────────────────────────────

  async charge(amount, reason) {
    if (amount <= 0) throw new Error("Amount must be positive");
    const maxCharge = 500 * this._reputation;
    if (amount > maxCharge) {
      throw new Error(
        `Amount $${amount.toFixed(2)} exceeds reputation ceiling $${maxCharge.toFixed(2)}`
      );
    }
    const tx = {
      id: crypto.randomUUID(),
      agentId: this.agentId,
      amount,
      reason,
      status: "pending",
      createdAt: new Date(),
    };
    this.transactions.set(tx.id, tx);
    this._audit("payment:pending", { id: tx.id, amount, reason });
    this.emit("payment:pending", { id: tx.id, amount, reason });
    return { ...tx };
  }

  async settle(txId) {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status !== "pending") throw new Error(`Transaction ${txId} is ${tx.status}`);

    tx.status = "completed";
    tx.completedAt = new Date();
    this._wallet += tx.amount;
    this._reputation = Math.min(this._reputation + 0.01, 1.0);

    // THE FEEDBACK LOOP: reinforce recently-accessed memories
    const oneHourAgo = Date.now() - 3_600_000;
    let reinforced = 0;
    for (const mem of this.memories.values()) {
      if (mem.lastAccessed.getTime() > oneHourAgo) {
        mem.importance = Math.min(mem.importance + 0.05, 1.0);
        reinforced++;
      }
    }

    this._audit("payment:completed", { id: tx.id, amount: tx.amount, reinforcedMemories: reinforced });
    this.emit("payment:completed", { id: tx.id, amount: tx.amount, reinforced });
    return { ...tx, reinforced };
  }

  async refund(txId) {
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error(`Transaction ${txId} not found`);
    if (tx.status === "refunded") throw new Error(`Already refunded`);

    if (tx.status === "completed") {
      this._wallet = Math.max(this._wallet - tx.amount, 0);
      this._reputation = Math.max(this._reputation - 0.05, 0);
    }
    tx.status = "refunded";

    this._audit("payment:refunded", { id: tx.id, amount: tx.amount });
    this.emit("payment:refunded", { id: tx.id });
    return { ...tx };
  }

  async balance() {
    return { wallet: this._wallet, reputation: this._reputation };
  }

  async profile() {
    return {
      id: this.agentId,
      reputation: this._reputation,
      wallet: this._wallet,
      memoriesCount: this.memories.size,
      transactionsCount: this.transactions.size,
    };
  }

  async history(limit = 20) {
    const all = Array.from(this.transactions.values());
    all.reverse();
    return all.slice(0, limit).map(tx => ({ ...tx }));
  }

  async logs(limit = 50) {
    return this.auditLog.slice(-limit);
  }
}
