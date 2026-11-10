import { ACTIVITIES, BADGES } from './activities.js';

const EDU_COMPONENTS_URL = 'https://tt-sensei.github.io/edu-components/index.js';
const SOUND_RECIPE_URL = 'https://tt-sensei.github.io/sounds-recipe-/sounds.js';
const NAVI_WEB = 'https://tt-sensei.github.io/navi-character-/assets/web';
const FANTASY_WEB = NAVI_WEB + '/fantasy';
const ACTIVITY_IDS = ACTIVITIES.map(function (item) { return item.id; });

const NAVI_ROLES = [
  { id: 'sora', file: 'sora-swordsman.webp' },
  { id: 'kai', file: 'kai-mage.webp' },
  { id: 'riku', file: 'riku-ninja.webp' },
  { id: 'saku', file: 'saku-cleric-healer.webp' },
  { id: 'tsuki', file: 'tsuki-archer.webp' },
  { id: 'nami', file: 'nami-guardian-knight.webp' }
];

let core = null;
let sounds = null;
let storage = null;
let progress = null;
let badgeManager = null;
let comboManager = null;
let state = null;
let soundEnabled = true;
let audioContext = null;
let currentActivity = null;
let session = null;
let currentQuestion = null;
let currentLegacyQuestion = null;
let matchCards = [];
let matchedCards = new Set();
let selectedMatch = -1;
let coachRole = NAVI_ROLES[1];
let toastTimer = 0;
let lastBadge = null;

function byId(id) { return document.getElementById(id); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function shuffled(items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    const temp = copy[i]; copy[i] = copy[j]; copy[j] = temp;
  }
  return copy;
}
function defaultState() {
  return { version: 1, stars: 0, totalCorrect: 0, bestCombo: 0, soundEnabled: true, activities: {}, mistakes: [] };
}
function mergeState(saved) {
  const base = defaultState();
  if (!saved || typeof saved !== 'object') return base;
  base.stars = Number.isFinite(saved.stars) ? Math.max(0, saved.stars) : 0;
  base.totalCorrect = Number.isFinite(saved.totalCorrect) ? Math.max(0, saved.totalCorrect) : 0;
  base.bestCombo = Number.isFinite(saved.bestCombo) ? Math.max(0, saved.bestCombo) : 0;
  base.soundEnabled = saved.soundEnabled !== false;
  base.activities = saved.activities && typeof saved.activities === 'object' ? saved.activities : {};
  base.mistakes = Array.isArray(saved.mistakes) ? saved.mistakes.slice(-50) : [];
  return base;
}
function makeFallbackStorage() {
  const prefix = 'edu:syousuumaster-park:';
  const memory = new Map();
  return {
    load: function (key, fallback) {
      if (memory.has(key)) return memory.get(key);
      try {
        const raw = localStorage.getItem(prefix + key);
        if (raw === null) return fallback;
        const value = JSON.parse(raw);
        memory.set(key, value);
        return value;
      } catch (error) { return fallback; }
    },
    save: function (key, value) {
      memory.set(key, value);
      try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch (error) { /* memory fallback */ }
      return true;
    }
  };
}
function makeFallbackProgress(ids) {
  const saved = storage.load('progress', { completed: [] });
  const completed = new Set(Array.isArray(saved.completed) ? saved.completed : []);
  return {
    complete: function (id) {
      if (!ids.includes(id)) return false;
      const changed = !completed.has(id);
      completed.add(id);
      if (changed) storage.save('progress', { completed: Array.from(completed) });
      return changed;
    },
    isCompleted: function (id) { return completed.has(id); },
    getCompletedCount: function () { return completed.size; },
    getPercent: function () { return Math.round(completed.size / ids.length * 100); }
  };
}
function makeFallbackBadges(definitions) {
  const saved = storage.load('badges', { awarded: [] });
  const awarded = new Set(Array.isArray(saved.awarded) ? saved.awarded : []);
  const byBadge = new Map(definitions.map(function (badge) { return [badge.id, badge]; }));
  return {
    award: function (id) {
      if (!byBadge.has(id) || awarded.has(id)) return false;
      awarded.add(id);
      storage.save('badges', { awarded: Array.from(awarded) });
      document.dispatchEvent(new CustomEvent('edu:badge', { detail: { id: id, badge: byBadge.get(id), awardedCount: awarded.size } }));
      return true;
    },
    has: function (id) { return awarded.has(id); },
    getAwardedCount: function () { return awarded.size; }
  };
}
function makeFallbackCombo() {
  let current = 0;
  let max = 0;
  return {
    correct: function () { current += 1; max = Math.max(max, current); return current; },
    wrong: function () { current = 0; return current; },
    reset: function () { current = 0; max = 0; },
    getCurrent: function () { return current; },
    getMax: function () { return max; }
  };
}
function saveState() {
  if (!storage || !state) return;
  state.soundEnabled = soundEnabled;
  storage.save('park-state', state);
}
function getActivityStats(id) {
  if (!state.activities[id] || typeof state.activities[id] !== 'object') {
    state.activities[id] = { played: 0, best: 0, mastered: false };
  }
  return state.activities[id];
}
function emitEvent(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}
function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () { toast.classList.remove('show'); }, 2300);
}
function currentRank() {
  if (state.stars >= 50) return '小数大王';
  if (state.stars >= 20) return '小数名人';
  if (state.stars >= 5) return '小数見習い卒業';
  return '見習い';
}
function updateTopStatus() {
  byId('star-count').textContent = String(state.stars);
  byId('rank-label').textContent = currentRank();
  byId('game-stars').textContent = String(state.stars);
  byId('sound-toggle').setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
  byId('sound-toggle').setAttribute('aria-label', soundEnabled ? '音をオフにする' : '音をオンにする');
  byId('sound-toggle').textContent = soundEnabled ? '♪' : '♩';
}
function updateProgressDisplay() {
  const completed = progress.getCompletedCount();
  const percent = progress.getPercent();
  byId('progress-label').textContent = completed + ' / ' + ACTIVITIES.length + ' エリア';
  byId('progress-fill').style.width = percent + '%';
}
function renderBadges() {
  const shelf = byId('badge-grid');
  shelf.innerHTML = BADGES.map(function (badge) {
    const earned = badgeManager.has(badge.id);
    return '<div class="badge-item ' + (earned ? 'earned' : 'locked') + '" title="' + (earned ? badge.description : 'まだ見つけていないバッジ') + '">' +
      '<img src="' + badge.image + '" alt="" loading="lazy">' +
      '<strong>' + badge.name + '</strong>' +
      '<span>' + (earned ? '獲得！' : 'チャレンジ中') + '</span></div>';
  }).join('');
  byId('badge-count').textContent = badgeManager.getAwardedCount() + ' / ' + BADGES.length;
}
function renderActivities() {
  byId('activity-grid').innerHTML = ACTIVITIES.map(function (activity) {
    const done = progress.isCompleted(activity.id);
    const stats = getActivityStats(activity.id);
    const stateLabel = done ? '✓ マスター' : (stats.played ? 'プレイ記録あり' : '▶ あそぶ');
    return '<button type="button" class="activity-card ' + (done ? 'is-done' : '') + '" data-activity="' + activity.id + '">' +
      '<div class="card-topline"><span class="card-category ' + activity.categoryTone + '">' + activity.category + '</span>' +
      '<span class="card-state">' + stateLabel + '</span></div>' +
      '<img class="card-art" src="' + activity.art + '" alt="" loading="lazy">' +
      '<h3>' + activity.title + '</h3><p class="card-subtitle">' + activity.subtitle + '</p>' +
      '<p class="card-description">' + activity.description + '</p>' +
      '<div class="card-bottom"><span class="card-grade">' + activity.grade + '</span>' +
      '<span class="card-state">' + (done ? 'もう一度挑戦 →' : (stats.played ? 'もう一度挑戦 →' : 'チャレンジ →')) + '</span></div></button>';
  }).join('');
  Array.from(document.querySelectorAll('.card-art')).forEach(function (image) {
    image.addEventListener('error', function () { image.hidden = true; }, { once: true });
  });
}
function updateTrainingDisplay() {
  const count = state.mistakes.length;
  const button = byId('weak-training-button');
  byId('training-summary').textContent = count
    ? 'まちがえた内容が ' + count + ' 件あるよ。近い問題でもう一度たしかめよう。'
    : '今は特訓する問題がないよ。まちがえた問題はここに集まるよ。';
  button.disabled = count === 0;
  button.textContent = count ? '弱点特訓をはじめる (' + Math.min(8, count) + '問)' : '特訓する問題はまだないよ';
}
function renderHome() {
  updateTopStatus();
  updateProgressDisplay();
  renderActivities();
  renderBadges();
  updateTrainingDisplay();
}
function showScreen(screenName) {
  byId('home-screen').hidden = screenName !== 'home';
  byId('game-screen').hidden = screenName !== 'game';
  byId('result-screen').hidden = screenName !== 'result';
  window.scrollTo(0, 0);
}
async function playSound(id) {
  if (!soundEnabled || !sounds || typeof sounds.playSound !== 'function') return;
  try {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext = new AudioContextClass();
    }
    await sounds.playSound(audioContext, id, 0.20);
  } catch (error) {
    // 音が再生できなくても学習の進行は止めない。
  }
}
function grantBadge(id) {
  if (!badgeManager || !id) return false;
  const earned = badgeManager.award(id);
  return earned;
}
function setCoach(message) {
  byId('coach-image').src = FANTASY_WEB + '/' + coachRole.file;
  byId('coach-line').textContent = message;
}
function setFeedback(message, type, mark) {
  const row = byId('feedback-row');
  row.className = 'feedback-row' + (type ? ' ' + type : '');
  byId('feedback-mark').textContent = mark || '';
  byId('feedback-text').textContent = message || '答えを選ぼう。';
}
function updateGameMeter() {
  let done = 0;
  let total = session ? session.total : 1;
  if (currentActivity && currentActivity.type === 'legacy') done = session.correct;
  else if (currentActivity && currentActivity.type === 'match') done = session.matched;
  else done = session.index;
  const labelNow = Math.min(total, done + 1);
  byId('game-step').textContent = currentActivity.type === 'legacy' ? session.correct + ' / ' + total + ' 正解' : labelNow + ' / ' + total;
  byId('question-count').textContent = currentActivity.type === 'legacy' ? 'あと ' + Math.max(0, total - session.correct) + ' 問正解で制覇' : (done + 1) + ' / ' + total;
  byId('game-meter-fill').style.width = Math.min(100, done / total * 100) + '%';
}
function renderTenthsBar(count, caption) {
  const cells = [];
  for (let i = 1; i <= 10; i += 1) cells.push('<span class="tenths-cell ' + (i <= count ? 'filled' : '') + '"></span>');
  return '<div class="tenths-visual"><div class="tenths-caption">' + caption + '</div><div class="tenths-bar">' + cells.join('') + '</div><div class="bar-label"><span>0</span><span>1</span></div></div>';
}
function makeChoices(answer, options) {
  const values = Array.from(new Set([String(answer)].concat(options.map(String))));
  return shuffled(values).map(function (value) { return { value: value, label: value }; });
}
function chooseOtherTenths(correct, count) {
  const pool = [];
  for (let n = 1; n <= 9; n += 1) if (String(n) !== String(correct)) pool.push(n);
  return shuffled(pool).slice(0, count).map(String);
}
function questionPiece() {
  const n = randomInt(1, 9);
  const correct = '0.' + n;
  return {
    type: 'choice', prompt: '0.1 のブロックが ' + n + 'こ。\nあわせると いくつ？',
    visualCount: n, answer: correct,
    choices: makeChoices(correct, ['0.' + (n === 1 ? 2 : n - 1), '0.' + (n === 9 ? 8 : n + 1), '1.0']),
    hint: '0.1が1こ、2こ、3こ……と増えると、小数の数字も1ずつ増えるよ。',
    explanation: '0.1が' + n + 'こで ' + correct + '。10こ集まると1になるよ。'
  };
}
function questionBuilder() {
  const n = randomInt(1, 9);
  return {
    type: 'builder',
    prompt: '0.1 のブロックを集めて、0.' + n + ' をつくろう！',
    targetCount: n,
    answer: '0.' + n,
    hint: '0.1を1こずつ増やして、ブロックが何こになったか数えよう。',
    explanation: '0.1が' + n + 'こで 0.' + n + '。'
  };
}
function questionCountTenths() {
  const n = randomInt(1, 9);
  return {
    type: 'choice', prompt: n + 'こ分の 0.1。\n小数で表すと？',
    visualCount: n, answer: '0.' + n,
    choices: makeChoices('0.' + n, ['0.' + (n === 1 ? 2 : n - 1), '0.' + (n === 9 ? 8 : n + 1), n + '.0']),
    hint: '1を10こに分けた1こ分が0.1。いくつ分あるか数えよう。',
    explanation: '0.1が' + n + 'こ分だから、' + n + '÷10の大きさで ' + '0.' + n + ' だよ。'
  };
}
function questionDecimalToCount() {
  const n = randomInt(1, 9);
  return {
    type: 'choice', prompt: '0.' + n + ' は、0.1 が何こ分？',
    visualCount: n, answer: String(n),
    choices: makeChoices(String(n), [String(n === 1 ? 2 : n - 1), String(n === 9 ? 8 : n + 1), String(n * 10)]),
    hint: '小数の小数点の右にある数字を見てみよう。0.1が何こ分かを表しているよ。',
    explanation: '0.' + n + ' は、0.1が' + n + 'こ分。'
  };
}
function questionFraction() {
  const n = randomInt(1, 9);
  const answer = '0.' + n;
  return {
    type: 'choice', prompt: n + '/10 と同じ大きさの小数は？',
    visualCount: n, answer: answer,
    choices: makeChoices(answer, ['0.' + (n === 1 ? 2 : n - 1), '0.' + (n === 9 ? 8 : n + 1), '1.0']),
    hint: '分母の10は、1を10こに分けたこと。分子は、そのうち何こ分かを表すよ。',
    explanation: n + '/10 は、1を10こに分けたうちの' + n + 'こ分。小数では ' + answer + ' と表すよ。'
  };
}
function questionCompare() {
  const a = randomInt(1, 9);
  let b = randomInt(1, 9);
  if (Math.random() < .15) b = a;
  else if (a === b) b = b === 9 ? 8 : b + 1;
  const answer = a > b ? 'left' : (a < b ? 'right' : 'same');
  return {
    type: 'compare',
    prompt: '大きいのはどちら？',
    left: '0.' + a, right: '0.' + b, leftCount: a, rightCount: b, answer: answer,
    choices: [
      { value: 'left', label: '左が大きい' },
      { value: 'same', label: '同じ大きさ' },
      { value: 'right', label: '右が大きい' }
    ],
    hint: '0.1のいくつ分かを比べると、大きさが見えてくるよ。',
    explanation: a === b ? 'どちらも0.1が' + a + 'こ分。だから同じ大きさだよ。' :
      (a > b ? '左は0.1が' + a + 'こ分、右は' + b + 'こ分。左の方が大きいね。' : '右は0.1が' + b + 'こ分、左は' + a + 'こ分。右の方が大きいね。')
  };
}
function questionNumberLine() {
  const n = randomInt(1, 9);
  return {
    type: 'numberline', prompt: '0.' + n + ' はどこの目盛り？',
    answer: '0.' + n,
    hint: '0から1までを10こに分けて、左から' + n + 'つ目の目盛りを探そう。',
    explanation: '0.' + n + ' は、0から数えて' + n + 'つ目の目盛りだよ。'
  };
}
function createQuestions(activity) {
  const list = [];
  for (let i = 0; i < activity.questionCount; i += 1) {
    if (activity.type === 'numberline') list.push(questionNumberLine());
    else if (activity.type === 'builder') list.push(questionBuilder());
    else if (activity.type === 'compare') list.push(questionCompare());
    else if (activity.type === 'mixed') {
      const mode = i % 6;
      if (mode === 0) list.push(questionPiece());
      else if (mode === 1) list.push(questionFraction());
      else if (mode === 2) list.push(questionNumberLine());
      else if (mode === 3) list.push(questionCompare());
      else if (mode === 4) list.push(questionDecimalToCount());
      else list.push(questionBuilder());
    }
  }
  return shuffled(list);
}
function createMatchCards() {
  const values = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, 6);
  const cards = [];
  values.forEach(function (n) {
    cards.push({ key: String(n), value: n, label: n + '/10', kind: 'fraction' });
    cards.push({ key: String(n), value: n, label: '0.' + n, kind: 'decimal' });
  });
  return shuffled(cards);
}
function renderMatchCards() {
  byId('answer-area').innerHTML = '<div class="match-grid">' + matchCards.map(function (card, index) {
    const selected = selectedMatch === index;
    const matched = matchedCards.has(index);
    return '<button type="button" class="match-card ' + card.kind + (selected ? ' selected' : '') + (matched ? ' matched' : '') + '" data-match-index="' + index + '" ' + (matched ? 'disabled' : '') + '>' + card.label + '</button>';
  }).join('') + '</div><div class="match-status">' + session.matched + ' / ' + session.total + ' ペアできた！</div>';
  Array.from(document.querySelectorAll('[data-match-index]')).forEach(function (button) {
    button.addEventListener('click', function () { handleMatch(Number(button.dataset.matchIndex)); });
  });
}
function renderBuilder() {
  const count = session.buildCount || 0;
  const cells = [];
  for (let i = 1; i <= 10; i += 1) cells.push('<span class="tenths-cell ' + (i <= count ? 'filled' : '') + '"></span>');
  const builtValue = count === 10 ? '1' : '0.' + count;
  byId('visual-area').innerHTML = '<div class="tenths-visual"><div class="tenths-caption">0.1ブロックを1こずつ集めよう</div><div class="tenths-bar">' + cells.join('') + '</div><div class="bar-label"><span>0</span><strong>いま ' + count + 'こ（' + builtValue + '）</strong><span>1</span></div></div>';
  byId('answer-area').innerHTML = '<div class="builder-controls"><button type="button" class="soft-button" id="builder-minus" ' + (count <= 0 ? 'disabled' : '') + '>− 1こ</button><button type="button" class="builder-add" id="builder-plus" ' + (count >= 10 ? 'disabled' : '') + '>＋ 0.1を1こ</button><button type="button" class="submit-button" id="builder-check">これで完成！</button></div>';
  byId('builder-minus').addEventListener('click', function () { session.buildCount = Math.max(0, count - 1); renderBuilder(); playSound('click'); });
  byId('builder-plus').addEventListener('click', function () { session.buildCount = Math.min(10, count + 1); renderBuilder(); playSound('click'); });
  byId('builder-check').addEventListener('click', submitBuilder);
}
function submitBuilder() {
  if (session.locked) return;
  const count = session.buildCount || 0;
  if (count === currentQuestion.targetCount) {
    session.locked = true;
    recordCorrect(currentQuestion.explanation);
    byId('builder-check').disabled = true;
    byId('builder-plus').disabled = true;
    byId('builder-minus').disabled = true;
    window.setTimeout(advanceQuestion, 700);
  } else {
    recordWrong(count < currentQuestion.targetCount
      ? 'あと ' + (currentQuestion.targetCount - count) + 'こ、0.1ブロックを集めよう。'
      : '少し多いみたい。目標の0.' + currentQuestion.targetCount + 'に合わせよう。');
  }
}
function renderNumberLine() {
  const ticks = [];
  for (let i = 0; i <= 10; i += 1) {
    const value = (i / 10).toFixed(1);
    ticks.push('<button type="button" class="line-tick ' + ((i === 0 || i === 10) ? 'endpoint' : '') + '" data-line-value="' + value + '" aria-label="' + value + '"></button>');
  }
  return '<div class="number-line-wrap"><div class="number-line">' + ticks.join('') + '</div><div class="line-labels"><span>0</span><span>1</span></div></div>';
}
function renderChoiceButtons(question) {
  const isCompare = question.type === 'compare';
  const html = question.choices.map(function (choice) {
    return '<button type="button" class="choice-button" data-choice="' + choice.value + '">' + choice.label + '</button>';
  }).join('');
  return '<div class="' + (isCompare ? 'compare-choices' : 'choice-grid') + '">' + html + '</div>';
}
function renderRegularQuestion() {
  currentQuestion = session.questions[session.index];
  if (currentQuestion.type === 'builder') session.buildCount = 0;
  byId('question-prompt').textContent = currentQuestion.prompt;
  let visual = '';
  if (currentQuestion.type === 'numberline') visual = '<div class="tenths-caption">0から1まで、10こに分けた数直線</div>';
  if (Number.isFinite(currentQuestion.visualCount)) visual += renderTenthsBar(currentQuestion.visualCount, '1を10こに分けたテープ');
  if (currentQuestion.type === 'compare') {
    visual += '<div class="compare-visual">' +
      '<div class="compare-side"><strong>' + currentQuestion.left + '</strong>' + renderTenthsBar(currentQuestion.leftCount, '左のテープ') + '</div>' +
      '<div class="compare-side"><strong>' + currentQuestion.right + '</strong>' + renderTenthsBar(currentQuestion.rightCount, '右のテープ') + '</div></div>';
  }
  if (currentQuestion.type === 'builder') {
    renderBuilder();
  } else if (currentQuestion.type === 'numberline') {
    byId('visual-area').innerHTML = visual;
    byId('answer-area').innerHTML = renderNumberLine();
    Array.from(document.querySelectorAll('[data-line-value]')).forEach(function (button) {
      button.addEventListener('click', function () { submitAnswer(button.dataset.lineValue, button); });
    });
  } else {
    byId('visual-area').innerHTML = visual;
    byId('answer-area').innerHTML = renderChoiceButtons(currentQuestion);
    Array.from(document.querySelectorAll('[data-choice]')).forEach(function (button) {
      button.addEventListener('click', function () { submitAnswer(button.dataset.choice, button); });
    });
  }
}
function renderLegacyQuestion() {
  session.locked = false;
  currentLegacyQuestion = makeLegacyQuestion(currentActivity.mode);
  byId('question-prompt').textContent = currentLegacyQuestion.prompt;
  byId('visual-area').innerHTML = currentActivity.mode === 'monster'
    ? renderTenthsBar(0, '0.1を集めて小数をつくろう')
    : '<div class="tenths-visual"><div class="tenths-caption">' + (currentActivity.mode === 'juice' ? '1 L = 10 dL' : '1 cm = 10 mm') + '</div><div class="bar-label"><span>10こ分の関係を使って考えよう</span><span>↔</span></div></div>';
  byId('answer-area').innerHTML = '<form class="legacy-answer" id="legacy-form"><input id="legacy-input" type="number" step="any" inputmode="decimal" autocomplete="off" aria-label="答え"><span class="legacy-unit">' + currentLegacyQuestion.unit + '</span><button class="submit-button" type="submit">こたえ合わせ</button></form>';
  byId('legacy-form').addEventListener('submit', function (event) {
    event.preventDefault();
    submitLegacyAnswer();
  });
}
function makeLegacyQuestion(mode) {
  // 既存版の出題範囲・双方向の出題式を維持する。
  const d1 = randomInt(0, 9);
  const d2 = randomInt(0, 9);
  const valDec = Number(d1 + '.' + d2);
  const valInt = d1 * 10 + d2;
  const isRev = Math.random() > .5;
  if (mode === 'juice') {
    if (!isRev) return { prompt: valDec.toFixed(1) + ' L は\n何 dL かな？', correctValue: valInt, unit: 'dL' };
    return { prompt: valInt + ' dL は\n何 L かな？', correctValue: valDec, unit: 'L' };
  }
  if (mode === 'ruler') {
    if (!isRev) return { prompt: valInt + ' mm は\n何 cm かな？', correctValue: valDec, unit: 'cm' };
    return { prompt: valDec.toFixed(1) + ' cm は\n何 mm かな？', correctValue: valInt, unit: 'mm' };
  }
  if (!isRev) return { prompt: valDec.toFixed(1) + ' のなかに\n0.1 は何こある？', correctValue: valInt, unit: 'こ' };
  return { prompt: '0.1 を ' + valInt + ' こ あつめると？', correctValue: valDec, unit: '' };
}
function renderGame() {
  if (!currentActivity || !session) return;
  byId('game-title').textContent = currentActivity.title;
  byId('game-category').textContent = currentActivity.category;
  byId('hint-button').hidden = false;
  byId('show-answer-button').hidden = currentActivity.type === 'match';
  byId('next-after-reveal').hidden = true;
  setFeedback('答えを選ぼう。', '', '');
  setCoach('図を見ながら考えてみよう。');
  if (currentActivity.type === 'match') {
    byId('question-prompt').textContent = '同じ大きさのカードを2まい見つけよう！';
    byId('visual-area').innerHTML = renderTenthsBar(0, '1を10こに分けたテープを思い出そう');
    renderMatchCards();
  } else if (currentActivity.type === 'legacy') {
    renderLegacyQuestion();
  } else {
    renderRegularQuestion();
  }
  updateGameMeter();
  updateTopStatus();
}
function startActivity(id) {
  const activity = ACTIVITIES.find(function (item) { return item.id === id; });
  if (!activity) return;
  currentActivity = activity;
  session = {
    id: id, total: activity.questionCount, correct: 0, attempts: 0, index: 0,
    matched: 0, skipped: 0, revealed: 0, locked: false, questions: []
  };
  lastBadge = null;
  selectedMatch = -1;
  matchedCards = new Set();
  matchCards = [];
  if (activity.type === 'match') matchCards = createMatchCards();
  else if (activity.type !== 'legacy') session.questions = createQuestions(activity);
  comboManager.reset();
  coachRole = NAVI_ROLES[randomInt(0, NAVI_ROLES.length - 1)];
  showScreen('game');
  renderGame();
  playSound('start');
}
function awardAfterActivity() {
  if (currentActivity.type === 'training') { saveState(); return; }
  const stats = getActivityStats(currentActivity.id);
  stats.played = (stats.played || 0) + 1;
  stats.best = Math.max(stats.best || 0, session.correct);
  if (session.correct >= session.total) {
    stats.mastered = true;
    if (currentActivity.badge) grantBadge(currentActivity.badge);
    progress.complete(currentActivity.id);
  }
  if (progress.getCompletedCount() === ACTIVITIES.length) grantBadge('park-tour');
  saveState();
}
function finishActivity() {
  if (!currentActivity || !session) return;
  awardAfterActivity();
  const perfect = session.correct >= session.total;
  byId('result-title').textContent = currentActivity.type === 'training'
    ? (perfect ? '弱点クリア！' : '特訓終了！')
    : (perfect ? 'エリアマスター！' : 'チャレンジ終了！');
  byId('result-message').textContent = perfect
    ? 'すべて正解！小数の見方がぐんと身に付いたね。'
    : '最後まで挑戦できたね。もう一度遊ぶと、もっと分かるよ。';
  byId('result-correct').textContent = String(session.correct);
  byId('result-total').textContent = ' / ' + session.total + ' 問正解';
  const badgeBox = byId('result-badge');
  if (lastBadge) {
    badgeBox.innerHTML = '<img src="' + lastBadge.image + '" alt=""><span>バッジ「' + lastBadge.name + '」をゲット！</span>';
  } else if (currentActivity.badge && badgeManager.has(currentActivity.badge)) {
    const def = BADGES.find(function (item) { return item.id === currentActivity.badge; });
    badgeBox.innerHTML = def ? '<img src="' + def.image + '" alt=""><span>獲得済みバッジ：' + def.name + '</span>' : '挑戦の記録が残ったよ！';
  } else {
    badgeBox.textContent = perfect ? 'マスター達成！' : 'バッジ獲得まで、あと少し！';
  }
  saveState();
  renderHome();
  showScreen('result');
  playSound(perfect ? 'mission' : 'practice');
}
function submitAnswer(value, button) {
  if (session.locked) return;
  if (String(value) === String(currentQuestion.answer)) {
    session.locked = true;
    if (button) button.classList.add('effect-correct-pop');
    recordCorrect(currentQuestion.explanation);
    Array.from(document.querySelectorAll('[data-choice], [data-line-value]')).forEach(function (item) { item.disabled = true; });
    window.setTimeout(advanceQuestion, 700);
  } else {
    if (button) button.classList.add('wrong');
    recordWrong('おしい！0.1が何こ分か、図でもう一度見てみよう。');
  }
}
function advanceQuestion() {
  if (!session || !currentActivity) return;
  session.index += 1;
  if (session.index >= session.total) finishActivity();
  else {
    session.locked = false;
    renderGame();
  }
}
function recordCorrect(explanation) {
  if (currentActivity.type === 'training' && currentQuestion && currentQuestion.mistakeId) {
    state.mistakes = state.mistakes.filter(function (mistake) { return mistake.id !== currentQuestion.mistakeId; });
  }
  session.correct += 1;
  session.attempts += 1;
  state.stars += 1;
  state.totalCorrect += 1;
  const streak = comboManager.correct();
  state.bestCombo = Math.max(state.bestCombo, comboManager.getMax());
  if (streak >= 5) grantBadge('combo');
  saveState();
  updateTopStatus();
  setFeedback('正解！ ' + (explanation || 'その調子！'), 'good', '✓');
  const panel = byId('question-panel');
  if (panel) { panel.classList.remove('effect-answer-celebrate'); void panel.offsetWidth; panel.classList.add('effect-answer-celebrate'); }
  setCoach(streak >= 3 ? streak + 'コンボ！すばらしい！' : 'いいね！その見方で合っているよ。');
  emitEvent('edu:correct', { isCorrect: true, answer: explanation || '', type: currentActivity.type });
  playSound('correct');
}
function recordWrong(message) {
  session.attempts += 1;
  if (currentActivity && currentActivity.type !== 'training') {
    state.mistakes.push({
      id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7),
      activityId: currentActivity.id,
      mode: currentActivity.mode || null,
      createdAt: Date.now()
    });
    state.mistakes = state.mistakes.slice(-50);
    saveState();
    updateTrainingDisplay();
  }
  comboManager.wrong();
  setFeedback(message || 'おしい！もう一度考えてみよう。', 'bad', '○');
  setCoach('大丈夫。図や目盛りを見て、もう一度やってみよう。');
  const panel = byId('question-prompt');
  panel.classList.remove('effect-wrong-shake');
  void panel.offsetWidth;
  panel.classList.add('effect-wrong-shake');
  emitEvent('edu:wrong', { isCorrect: false, type: currentActivity.type });
  playSound('softFail');
}
function handleMatch(index) {
  if (session.locked || matchedCards.has(index) || selectedMatch === index) return;
  if (selectedMatch < 0) {
    selectedMatch = index;
    renderMatchCards();
    playSound('click');
    const selected = matchCards[index];
    byId('visual-area').innerHTML = renderTenthsBar(selected.value, selected.label + ' の大きさ');
    setFeedback('もう1まい、同じ大きさを探そう。', '', '');
    return;
  }
  const firstIndex = selectedMatch;
  const first = matchCards[firstIndex];
  const second = matchCards[index];
  if (first.key === second.key && first.kind !== second.kind) {
    matchedCards.add(firstIndex);
    matchedCards.add(index);
    selectedMatch = -1;
    session.matched += 1;
    session.locked = true;
    recordCorrect(first.value + '/10 と 0.' + first.value + ' は同じ大きさ！');
    setFeedback(first.value + '/10 = 0.' + first.value + '。同じ大きさだね！', 'good', '✓');
    byId('visual-area').innerHTML = renderTenthsBar(first.value, first.value + '/10 = 0.' + first.value);
    window.setTimeout(function () {
      if (session.matched >= session.total) finishActivity();
      else { session.locked = false; renderMatchCards(); }
    }, 650);
  } else {
    session.locked = true;
    recordWrong('ちがうカードみたい。10等分した図を見てみよう。');
    selectedMatch = index;
    renderMatchCards();
    window.setTimeout(function () {
      selectedMatch = -1;
      session.locked = false;
      renderMatchCards();
    }, 650);
  }
  updateGameMeter();
}
function hintCurrent() {
  if (currentActivity.type === 'match') {
    setCoach('分母が10の分数は、1を10こに分けたうちの何こ分かを表すよ。');
    setFeedback('1/10 は 0.1。10こに分けた1こ分だよ。', '', '？');
    return;
  }
  if (currentActivity.type === 'legacy') {
    const mode = currentActivity.mode;
    const hint = mode === 'juice' ? '1 L = 10 dL。LからdLは10倍、dLからLは10でわるよ。'
      : (mode === 'ruler' ? '1 cm = 10 mm。cmからmmは10倍、mmからcmは10でわるよ。'
        : '0.1が何こ分かを数えてみよう。たとえば0.7は0.1が7こ分。');
    setCoach(hint);
    setFeedback(hint, '', '？');
    return;
  }
  setCoach(currentQuestion.hint || '0.1が何こ分かを考えてみよう。');
  setFeedback(currentQuestion.hint || '図や数直線を使って考えよう。', '', '？');
}
function revealAnswer() {
  if (!currentActivity || currentActivity.type === 'match') return;
  if (currentActivity.type === 'legacy') {
    const value = currentLegacyQuestion.correctValue;
    setFeedback('こたえは ' + value + ' ' + currentLegacyQuestion.unit + ' だよ。答えを見た分は正解に入らないよ。', '', '？');
    session.locked = true;
    const input = byId('legacy-input');
    const submit = document.querySelector('#legacy-form button');
    if (input) input.disabled = true;
    if (submit) submit.disabled = true;
  } else {
    const q = currentQuestion;
    let answerText = q.answer;
    if (q.type === 'compare') answerText = q.answer === 'left' ? '左が大きい' : (q.answer === 'right' ? '右が大きい' : '同じ大きさ');
    if (q.type === 'numberline') answerText = q.answer;
    setFeedback('こたえは ' + answerText + '。' + (q.explanation || ''), '', '？');
    session.locked = true;
  }
  session.revealed += 1;
  byId('next-after-reveal').hidden = false;
  byId('show-answer-button').hidden = true;
  byId('hint-button').hidden = true;
  setCoach('答えを見て、考え方を確かめよう。');
}
function skipAfterReveal() {
  if (!session) return;
  if (currentActivity.type === 'legacy') {
    renderGame();
    return;
  }
  session.skipped += 1;
  advanceQuestion();
}
function submitLegacyAnswer() {
  if (session.locked) return;
  const input = byId('legacy-input');
  if (!input || input.value.trim() === '') {
    setFeedback('答えを入力してね。', 'bad', '!');
    return;
  }
  const value = Number(input.value);
  if (Number.isFinite(value) && Math.abs(value - currentLegacyQuestion.correctValue) < 0.01) {
    session.locked = true;
    recordCorrect('正解！その調子！');
    if (session.correct >= session.total) window.setTimeout(finishActivity, 650);
    else window.setTimeout(function () { renderGame(); }, 650);
  } else {
    recordWrong('おしい！単位の関係を思い出して、もう一度。');
  }
}
function nextLegacyQuestion() {
  session.locked = false;
  currentLegacyQuestion = makeLegacyQuestion(currentActivity.mode);
}
function makeLegacyTrainingQuestion(mode) {
  const old = makeLegacyQuestion(mode);
  const answer = String(old.correctValue);
  const numeric = Number(answer);
  const distractors = mode === 'monster'
    ? [String(Math.max(0, numeric - 1)), String(numeric + 1), String(numeric + 10)]
    : [String(Number((numeric + 1).toFixed(1))), String(Number((numeric - 1).toFixed(1))), String(Number((numeric + 10).toFixed(1)))];
  return {
    type: 'choice', prompt: old.prompt, answer: answer,
    choices: makeChoices(answer, distractors),
    hint: mode === 'juice' ? '1 L = 10 dL。向きに合わせて10倍か10でわろう。'
      : (mode === 'ruler' ? '1 cm = 10 mm。向きに合わせて10倍か10でわろう。' : '0.1が何こ分かを数えよう。'),
    explanation: 'こたえは ' + answer + ' ' + old.unit + ' だよ。'
  };
}
function questionForMistake(mistake) {
  const activity = ACTIVITIES.find(function (item) { return item.id === mistake.activityId; });
  if (!activity) return questionFraction();
  if (activity.type === 'legacy') return makeLegacyTrainingQuestion(activity.mode);
  if (activity.type === 'match') return questionFraction();
  if (activity.type === 'numberline') return questionNumberLine();
  if (activity.type === 'builder') return questionBuilder();
  if (activity.type === 'compare') return questionCompare();
  const choices = [questionPiece, questionFraction, questionNumberLine, questionCompare, questionBuilder];
  return choices[randomInt(0, choices.length - 1)]();
}
function startWeakTraining() {
  const mistakes = state.mistakes.slice(-8).reverse();
  if (!mistakes.length) { showToast('今は特訓する問題がないよ。'); return; }
  currentActivity = { id: 'weak-training', title: '弱点特訓', type: 'training', category: 'まちがえた内容を復習', questionCount: mistakes.length, badge: null };
  session = {
    id: 'weak-training', total: mistakes.length, correct: 0, attempts: 0, index: 0,
    matched: 0, skipped: 0, revealed: 0, locked: false,
    questions: mistakes.map(function (mistake) {
      const question = questionForMistake(mistake);
      question.mistakeId = mistake.id;
      return question;
    })
  };
  comboManager.reset();
  lastBadge = null;
  coachRole = NAVI_ROLES.find(function (role) { return role.id === 'nami'; }) || NAVI_ROLES[1];
  showScreen('game');
  renderGame();
  setCoach('まちがえたところを、もう一度ゆっくり確かめよう。');
  playSound('start');
}
function initEvents() {
  byId('activity-grid').addEventListener('click', function (event) {
    const card = event.target.closest('[data-activity]');
    if (card) { playSound('click'); startActivity(card.dataset.activity); }
  });
  byId('sound-toggle').addEventListener('click', function () {
    soundEnabled = !soundEnabled;
    saveState();
    updateTopStatus();
    if (soundEnabled) playSound('decide');
  });
  byId('back-home').addEventListener('click', function () {
    currentActivity = null; session = null; renderHome(); showScreen('home');
  });
  byId('hint-button').addEventListener('click', hintCurrent);
  byId('show-answer-button').addEventListener('click', revealAnswer);
  byId('next-after-reveal').addEventListener('click', skipAfterReveal);
  byId('retry-activity').addEventListener('click', function () {
    if (!currentActivity) return;
    if (currentActivity.type === 'training') startWeakTraining();
    else startActivity(currentActivity.id);
  });
  byId('weak-training-button').addEventListener('click', startWeakTraining);
  byId('result-home').addEventListener('click', function () {
    currentActivity = null; session = null; renderHome(); showScreen('home');
  });
}
async function init() {
  const loaded = await Promise.all([
    import(EDU_COMPONENTS_URL).catch(function () { return null; }),
    import(SOUND_RECIPE_URL).catch(function () { return null; })
  ]);
  core = loaded[0];
  sounds = loaded[1];
  storage = core && core.StorageManager
    ? new core.StorageManager('syousuumaster-park', { eventTarget: document })
    : makeFallbackStorage();
  state = mergeState(storage.load('park-state', defaultState()));
  soundEnabled = state.soundEnabled !== false;
  progress = core && core.ProgressManager
    ? new core.ProgressManager({ storage: storage, storageKey: 'progress', ids: ACTIVITY_IDS, eventTarget: document })
    : makeFallbackProgress(ACTIVITY_IDS);
  badgeManager = core && core.BadgeManager
    ? new core.BadgeManager({ storage: storage, storageKey: 'badges', badges: BADGES, eventTarget: document })
    : makeFallbackBadges(BADGES);
  comboManager = core && core.ComboManager
    ? new core.ComboManager({ eventTarget: document, milestones: [3, 5, 10] })
    : makeFallbackCombo();

  document.addEventListener('edu:badge', function (event) {
    const badge = event.detail && event.detail.badge;
    if (!badge) return;
    lastBadge = badge;
    const toast = byId('toast');
    toast.classList.remove('effect-badge-unlock');
    void toast.offsetWidth;
    toast.classList.add('effect-badge-unlock');
    showToast('バッジ「' + badge.name + '」をゲット！');
    playSound('badge');
  });
  initEvents();
  renderHome();
  saveState();
}
init();
