import { MnemoPayLite } from "./mnemopay-lite.js";

// ── Freelancer data ─────────────────────────────────────────────────────

const FREELANCERS = [
  {
    name: "Alice",
    price: 80,
    quality: 0.5, // 50% chance of good outcome
    trait: "Fast but sloppy. Delivers quickly, often with bugs.",
    goodMsg: "Delivered on time, minor issues only.",
    badMsg: "Code was full of bugs. Had to redo half of it.",
  },
  {
    name: "Bob",
    price: 150,
    quality: 0.9, // 90% chance of good outcome
    trait: "Expensive but reliable. Almost always delivers clean work.",
    goodMsg: "Perfect delivery. Clean code, tested, documented.",
    badMsg: "Missed the deadline by 3 days. Work was fine but late.",
  },
  {
    name: "Carol",
    price: 110,
    quality: 0.7, // 70% chance of good outcome
    trait: "Solid middle ground. Usually good, occasionally misses.",
    goodMsg: "Good quality work, delivered on schedule.",
    badMsg: "Delivered incomplete work. Key features missing.",
  },
];

const TASKS = [
  { name: "Build a landing page", budget: 200 },
  { name: "Fix authentication bugs", budget: 180 },
  { name: "Add payment integration", budget: 250 },
  { name: "Design a dashboard UI", budget: 220 },
  { name: "Write API documentation", budget: 150 },
  { name: "Optimize database queries", budget: 200 },
  { name: "Set up CI/CD pipeline", budget: 180 },
  { name: "Build email notification system", budget: 190 },
  { name: "Create user onboarding flow", budget: 210 },
  { name: "Implement search functionality", budget: 230 },
];

// ── State ────────────────────────────────────────────────────────────────

let agent = new MnemoPayLite("demo-agent", 0.001); // Very slow decay for demo
let currentRound = 0;
let totalSpent = 0;
let goodOutcomes = 0;
let badOutcomes = 0;
let isProcessing = false;
const MAX_ROUNDS = 10;

// ── DOM refs ─────────────────────────────────────────────────────────────

const $round = document.getElementById("round-label");
const $taskName = document.getElementById("task-name");
const $taskBudget = document.getElementById("task-budget");
const $freelancers = document.getElementById("freelancers");
const $agentDecide = document.getElementById("agent-decide");
const $outcomeCard = document.getElementById("outcome-card");
const $decisionLog = document.getElementById("decision-log");
const $memoryPanel = document.getElementById("memory-panel");
const $repScore = document.getElementById("rep-score");
const $walletBalance = document.getElementById("wallet-balance");
const $memCount = document.getElementById("mem-count");
const $successRate = document.getElementById("success-rate");
const $codeModal = document.getElementById("code-modal");
const $gameOver = document.getElementById("game-over");
const $gameOverMsg = document.getElementById("game-over-msg");

// ── Init ─────────────────────────────────────────────────────────────────

function startRound() {
  if (currentRound >= MAX_ROUNDS) {
    showGameOver();
    return;
  }

  const task = TASKS[currentRound];
  $round.textContent = `Round ${currentRound + 1} of ${MAX_ROUNDS}`;
  $taskName.textContent = task.name;
  $taskBudget.textContent = `Budget: $${task.budget}`;
  $outcomeCard.classList.remove("active", "good", "bad");
  $gameOver.classList.remove("active");

  renderFreelancers();
  $agentDecide.disabled = false;
  isProcessing = false;
}

async function renderFreelancers() {
  // Get agent's memory to show recommendations
  const memories = await agent.recall(10);
  const cards = FREELANCERS.map((f) => {
    const relevantMemory = memories.find(m =>
      m.content.toLowerCase().includes(f.name.toLowerCase())
    );
    const card = document.createElement("div");
    card.className = "freelancer-card";
    card.innerHTML = `
      <div class="name">${f.name}</div>
      <div class="price">$${f.price}</div>
      <div class="rating">${"*".repeat(Math.round(f.quality * 5))}${"*".repeat(5 - Math.round(f.quality * 5))} (hidden)</div>
      <div class="trait">${f.trait}</div>
      ${relevantMemory ? `<div class="agent-rec">Agent memory: "${relevantMemory.content.slice(0, 60)}..." [${relevantMemory.importance.toFixed(2)}]</div>` : ""}
    `;
    card.addEventListener("click", () => pickFreelancer(f));
    return card;
  });

  $freelancers.innerHTML = "";
  cards.forEach(c => $freelancers.appendChild(c));
}

async function pickFreelancer(freelancer) {
  if (isProcessing) return;
  isProcessing = true;

  // Disable all cards
  document.querySelectorAll(".freelancer-card").forEach(c => c.classList.add("disabled"));
  $agentDecide.disabled = true;

  const task = TASKS[currentRound];
  const isGood = Math.random() < freelancer.quality;

  // Recall memories before making the decision (this is what settle() will reinforce)
  await agent.recall(5);

  // Create escrow
  const tx = await agent.charge(freelancer.price, `${task.name} by ${freelancer.name}`);
  totalSpent += freelancer.price;

  if (isGood) {
    // Good outcome: settle payment, memories reinforced
    const result = await agent.settle(tx.id);
    await agent.remember(
      `${freelancer.name} delivered successfully on "${task.name}" for $${freelancer.price}. ${freelancer.goodMsg}`,
      { importance: 0.7, tags: ["success", freelancer.name.toLowerCase()] }
    );
    goodOutcomes++;

    showOutcome(true, freelancer, task, result.reinforced);
    addDecisionLog(freelancer, task, true, tx.amount);
  } else {
    // Bad outcome: refund, reputation docked
    await agent.refund(tx.id);
    await agent.remember(
      `${freelancer.name} failed on "${task.name}". ${freelancer.badMsg} Refunded $${freelancer.price}.`,
      { importance: 0.8, tags: ["failure", freelancer.name.toLowerCase()] }
    );
    badOutcomes++;

    showOutcome(false, freelancer, task, 0);
    addDecisionLog(freelancer, task, false, tx.amount);
  }

  await updateStats();
  await renderMemories();
  currentRound++;

  // Auto-advance after 2 seconds
  setTimeout(() => startRound(), 2000);
}

async function agentDecides() {
  if (isProcessing) return;

  // Agent uses its memory to pick
  const memories = await agent.recall(10);
  let bestFreelancer = FREELANCERS[0];
  let bestScore = -1;

  for (const f of FREELANCERS) {
    let score = 0;
    let successCount = 0;
    let failCount = 0;

    for (const mem of memories) {
      const content = mem.content.toLowerCase();
      const name = f.name.toLowerCase();
      if (content.includes(name)) {
        if (content.includes("success") || content.includes("delivered")) {
          successCount++;
          score += mem.importance * 2;
        }
        if (content.includes("fail") || content.includes("refund")) {
          failCount++;
          score -= mem.importance * 3;
        }
      }
    }

    // If no memories about this freelancer, give a neutral score based on price
    if (successCount === 0 && failCount === 0) {
      score = 0.5 - (f.price / 300); // Slight preference for cheaper when no data
    }

    if (score > bestScore) {
      bestScore = score;
      bestFreelancer = f;
    }
  }

  pickFreelancer(bestFreelancer);
}

function showOutcome(isGood, freelancer, task, reinforced) {
  $outcomeCard.className = `outcome-card active ${isGood ? "good" : "bad"}`;
  $outcomeCard.innerHTML = `
    <div class="msg">${isGood ? "Payment settled!" : "Refund triggered!"}</div>
    <div class="detail">
      ${freelancer.name} ${isGood ? freelancer.goodMsg : freelancer.badMsg}
      ${isGood ? `<br>${reinforced} memories reinforced (+0.05 each)` : "<br>Reputation docked -0.05"}
    </div>
  `;
}

function addDecisionLog(freelancer, task, isGood, amount) {
  const entry = document.createElement("div");
  entry.className = "decision-entry";
  entry.innerHTML = `
    <div class="round">Round ${currentRound + 1}</div>
    <div class="choice">Hired ${freelancer.name} for "${task.name}" — $${amount}</div>
    <div class="outcome ${isGood ? "settled" : "refunded"}">
      ${isGood ? "Settled. Memories reinforced." : "Refunded. Reputation docked."}
    </div>
  `;

  // Remove empty state if present
  const empty = $decisionLog.querySelector(".empty-state");
  if (empty) empty.remove();

  $decisionLog.insertBefore(entry, $decisionLog.firstChild.nextSibling); // After the h2
}

async function renderMemories() {
  const memories = await agent.recall(20);
  const h2 = $memoryPanel.querySelector("h2");
  $memoryPanel.innerHTML = "";
  $memoryPanel.appendChild(h2);

  if (memories.length === 0) {
    $memoryPanel.innerHTML += '<div class="empty-state">No memories yet. Pick a freelancer to start.</div>';
    return;
  }

  for (const mem of memories) {
    const isSuccess = mem.tags.includes("success");
    const isFailure = mem.tags.includes("failure");
    const entry = document.createElement("div");
    entry.className = `memory-entry ${isSuccess ? "reinforced" : ""} ${isFailure ? "decayed" : ""}`;
    entry.innerHTML = `
      <div class="content">${mem.content.slice(0, 80)}${mem.content.length > 80 ? "..." : ""}</div>
      <div class="meta">
        <span>Importance: ${mem.importance.toFixed(2)}</span>
        <span>Score: ${mem.score.toFixed(3)}</span>
      </div>
      <div class="score-bar">
        <div class="score-fill ${mem.importance < 0.4 ? "low" : ""}" style="width: ${(mem.importance * 100).toFixed(0)}%"></div>
      </div>
    `;
    $memoryPanel.appendChild(entry);
  }
}

async function updateStats() {
  const bal = await agent.balance();
  const profile = await agent.profile();

  $repScore.textContent = bal.reputation.toFixed(2);
  $walletBalance.textContent = `$${bal.wallet.toFixed(0)}`;
  $memCount.textContent = profile.memoriesCount;
  $successRate.textContent = (goodOutcomes + badOutcomes) > 0
    ? `${Math.round((goodOutcomes / (goodOutcomes + badOutcomes)) * 100)}%`
    : "—";
}

function showGameOver() {
  const rate = Math.round((goodOutcomes / MAX_ROUNDS) * 100);
  $gameOver.classList.add("active");
  $gameOverMsg.innerHTML = `
    Over ${MAX_ROUNDS} rounds, the agent achieved a ${rate}% success rate.<br>
    Memories that led to good hires got stronger. Memories from bad hires decayed.<br>
    <strong>That's the MnemoPay feedback loop.</strong> Economic outcomes shape agent memory.
  `;
  // Disable freelancer selection
  document.querySelectorAll(".freelancer-card").forEach(c => c.classList.add("disabled"));
  $agentDecide.disabled = true;
}

function resetDemo() {
  agent = new MnemoPayLite("demo-agent", 0.001);
  currentRound = 0;
  totalSpent = 0;
  goodOutcomes = 0;
  badOutcomes = 0;
  isProcessing = false;

  $decisionLog.innerHTML = '<h2>Decision Log</h2><div class="empty-state">Decisions will appear here as you hire freelancers.</div>';
  $memoryPanel.innerHTML = '<h2>Agent Memory (Live)</h2><div class="empty-state">No memories yet. Pick a freelancer to start.</div>';
  $repScore.textContent = "0.50";
  $walletBalance.textContent = "$0";
  $memCount.textContent = "0";
  $successRate.textContent = "—";
  $gameOver.classList.remove("active");

  startRound();
}

// ── Modal ────────────────────────────────────────────────────────────────

function openCodeModal() {
  $codeModal.classList.add("active");
}

function closeCodeModal() {
  $codeModal.classList.remove("active");
}

// ── Wire up ──────────────────────────────────────────────────────────────

document.getElementById("agent-decide").addEventListener("click", agentDecides);
document.getElementById("btn-reset").addEventListener("click", resetDemo);
document.getElementById("btn-code").addEventListener("click", openCodeModal);
document.getElementById("close-modal").addEventListener("click", closeCodeModal);
$codeModal.addEventListener("click", (e) => {
  if (e.target === $codeModal) closeCodeModal();
});

// Start
startRound();
