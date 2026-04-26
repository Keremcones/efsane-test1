const fs = require('fs');
const path = require('path');
const vm = require('vm');

function toNumberLike(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = parseFloat(String(value).replace('%', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(String(k)),
    clear: () => map.clear(),
  };
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const indicatorsPath = path.join(projectRoot, 'public', 'indicators.js');
  const sourcePath = path.join(projectRoot, 'public', 'advanced-indicators.js');
  const indicatorsCode = fs.readFileSync(indicatorsPath, 'utf8');
  const sourceCode = fs.readFileSync(sourcePath, 'utf8');

  global.window = {
    BINANCE_SPOT_API_BASE: 'https://api.binance.com/api/v3',
    BINANCE_FUTURES_API_BASE: 'https://fapi.binance.com/fapi/v1',
    REALTIME_ENABLED: false,
  };
  global.localStorage = makeStorage();

  vm.runInThisContext(indicatorsCode, { filename: indicatorsPath });
  vm.runInThisContext(sourceCode, { filename: sourcePath });

  if (!global.window.AdvancedIndicators || typeof global.window.AdvancedIndicators.runBacktest !== 'function') {
    throw new Error('AdvancedIndicators.runBacktest bulunamadi');
  }

  const AI = global.window.AdvancedIndicators;

  const coins = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const timeframe = '5m';
  const marketType = 'futures';
  const directionFilter = 'BOTH';

  const testParams = {
    days: 60,
    confidence: 40,
    tp: 1,
    sl: 3,
    slippageBps: 3,
    feeBps: 5,
  };

  const oldStrategy = null;
  const newStrategy = {
    strongRegimeAdx: 16,
    bullishMomentumRsi: 55,
    bearishMomentumRsi: 45,
    momentumConflictAdx: 14,
    choppyConfidenceBoost: 12,
    hasTrendOrAdx: 24,
  };

  const rows = [];

  for (const coin of coins) {
    console.log(`\n=== ${coin} basladi ===`);

    const oldResult = await AI.runBacktest(
      coin,
      timeframe,
      testParams.days,
      testParams.confidence,
      testParams.tp,
      testParams.sl,
      marketType,
      directionFilter,
      testParams.slippageBps,
      testParams.feeBps,
      oldStrategy
    );

    const newResult = await AI.runBacktest(
      coin,
      timeframe,
      testParams.days,
      testParams.confidence,
      testParams.tp,
      testParams.sl,
      marketType,
      directionFilter,
      testParams.slippageBps,
      testParams.feeBps,
      newStrategy
    );

    const oldTrades = Number(oldResult?.totalTrades || 0);
    const newTrades = Number(newResult?.totalTrades || 0);

    const oldProfit = toNumberLike(oldResult?.totalProfit);
    const newProfit = toNumberLike(newResult?.totalProfit);

    const oldWin = toNumberLike(oldResult?.winRate);
    const newWin = toNumberLike(newResult?.winRate);

    const oldPf = toNumberLike(oldResult?.profitFactor);
    const newPf = toNumberLike(newResult?.profitFactor);

    rows.push({
      coin,
      old: {
        totalTrades: oldTrades,
        totalProfit: oldProfit,
        winRate: oldWin,
        profitFactor: oldPf,
      },
      newer: {
        totalTrades: newTrades,
        totalProfit: newProfit,
        winRate: newWin,
        profitFactor: newPf,
      },
      delta: {
        totalTrades: newTrades - oldTrades,
        totalProfit: Number((newProfit - oldProfit).toFixed(2)),
        winRate: Number((newWin - oldWin).toFixed(2)),
        profitFactor: Number((newPf - oldPf).toFixed(2)),
      }
    });

    console.log(`${coin} tamamlandi: old=${oldProfit.toFixed(2)}% new=${newProfit.toFixed(2)}%`);
  }

  const aggregate = rows.reduce((acc, row) => {
    acc.old.totalTrades += row.old.totalTrades;
    acc.old.totalProfit += row.old.totalProfit;
    acc.old.winRate += row.old.winRate;
    acc.old.profitFactor += row.old.profitFactor;

    acc.newer.totalTrades += row.newer.totalTrades;
    acc.newer.totalProfit += row.newer.totalProfit;
    acc.newer.winRate += row.newer.winRate;
    acc.newer.profitFactor += row.newer.profitFactor;
    return acc;
  }, {
    old: { totalTrades: 0, totalProfit: 0, winRate: 0, profitFactor: 0 },
    newer: { totalTrades: 0, totalProfit: 0, winRate: 0, profitFactor: 0 },
  });

  const n = rows.length || 1;
  aggregate.old.winRate = Number((aggregate.old.winRate / n).toFixed(2));
  aggregate.old.profitFactor = Number((aggregate.old.profitFactor / n).toFixed(2));
  aggregate.old.totalProfit = Number(aggregate.old.totalProfit.toFixed(2));

  aggregate.newer.winRate = Number((aggregate.newer.winRate / n).toFixed(2));
  aggregate.newer.profitFactor = Number((aggregate.newer.profitFactor / n).toFixed(2));
  aggregate.newer.totalProfit = Number(aggregate.newer.totalProfit.toFixed(2));

  aggregate.delta = {
    totalTrades: aggregate.newer.totalTrades - aggregate.old.totalTrades,
    totalProfit: Number((aggregate.newer.totalProfit - aggregate.old.totalProfit).toFixed(2)),
    winRate: Number((aggregate.newer.winRate - aggregate.old.winRate).toFixed(2)),
    profitFactor: Number((aggregate.newer.profitFactor - aggregate.old.profitFactor).toFixed(2)),
  };

  const output = {
    meta: {
      timeframe,
      marketType,
      params: testParams,
      coins,
      note: 'Yeni profil daha secici sinyal filtresiyle olculdu (counter-candle/re-entry birebir edge simulasyonu degil).',
    },
    rows,
    aggregate,
  };

  const outPath = path.join(projectRoot, 'temp', 'backtest_compare_5m_results.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSONUC_DOSYASI=${outPath}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error('HATA:', err);
  process.exitCode = 1;
});
