const RUNS = 1500;
const HORIZON = 13;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function stableSeed(value) {
  let hash = 2166136261;
  for (const char of JSON.stringify(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normal(random) {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function simulate({ openingCash, reserve, flows, scenario, seed }) {
  const random = seededRandom(seed);
  const paths = Array.from({ length: RUNS }, () => Array(HORIZON + 1).fill(openingCash));
  const weeklyFlows = flows.map(flow => ({ ...flow }));

  // Same rules as the chart: the delay slider moves the NEXT expected receipt week,
  // and the sales change applies to every expected receipt.
  const firstReceiptWeek = Math.min(...weeklyFlows.filter(flow => flow.type === 'in' && flow.amount > 0).map(flow => Math.min(HORIZON, flow.week)));
  for (let run = 0; run < RUNS; run += 1) {
    const inflows = Array(HORIZON + 1).fill(0);
    const outflows = Array(HORIZON + 1).fill(0);

    for (const flow of weeklyFlows) {
      const week = Math.min(HORIZON, flow.week);
      if (flow.type === 'in') {
        // With no account-specific payment history yet, expected receipts may land
        // roughly one week early or late. The delay slider shifts that distribution.
        const delayShift = week === firstReceiptWeek ? scenario.delayWeeks : 0;
        const receiptWeek = Math.max(1, Math.round(week + delayShift + normal(random) * 0.6));
        if (receiptWeek <= HORIZON) {
          const salesFactor = 1 + scenario.salesChange / 100;
          inflows[receiptWeek] += flow.amount * salesFactor;
        }
      } else {
        outflows[Math.max(1, week)] += flow.amount;
      }
    }

    if (scenario.extraExpense > 0) outflows[1] += scenario.extraExpense;
    for (let week = 1; week <= HORIZON; week += 1) {
      paths[run][week] = paths[run][week - 1] + inflows[week] - outflows[week];
    }
  }

  const weekly = Array.from({ length: HORIZON + 1 }, (_, week) => {
    const balances = paths.map(path => path[week]).sort((a, b) => a - b);
    return {
      p10: quantile(balances, 0.1),
      p50: quantile(balances, 0.5),
      p90: quantile(balances, 0.9)
    };
  });
  let belowReserve = 0;
  let belowZero = 0;
  const minimums = [];
  const breachWeeks = [];
  for (const path of paths) {
    const future = path.slice(1);
    const low = Math.min(...future);
    minimums.push(low);
    const reserveBreach = future.findIndex(balance => balance < reserve);
    if (reserveBreach !== -1) {
      belowReserve += 1;
      breachWeeks.push(reserveBreach + 1);
    }
    if (future.some(balance => balance < 0)) belowZero += 1;
  }
  breachWeeks.sort((a, b) => a - b);
  return {
    weekly,
    probabilityBelowReserve: reserve > 0 ? belowReserve / RUNS : null,
    probabilityNegative: belowZero / RUNS,
    expectedLowestBalance: minimums.reduce((sum, value) => sum + value, 0) / RUNS,
    medianBreachWeek: breachWeeks.length ? quantile(breachWeeks, 0.5) : null
  };
}

export function predictCashflow(input) {
  const { openingCash, reserve, flows, scenario } = input;
  const seed = stableSeed(input);
  const baseline = simulate({
    openingCash,
    reserve,
    flows,
    scenario: { delayWeeks: 0, extraExpense: 0, salesChange: 0 },
    seed
  });
  const projected = simulate({ openingCash, reserve, flows, scenario, seed });
  return {
    runs: RUNS,
    assumptions: { receiptTimingStdDevWeeks: 0.6, personalizedPaymentHistory: false },
    baseline,
    scenario: projected
  };
}

export function validatePredictionInput(body) {
  const openingCash = Number(body?.openingCash);
  const reserve = Number(body?.reserve ?? 0);
  const flows = body?.flows;
  const scenario = {
    delayWeeks: Number(body?.scenario?.delayWeeks ?? 0),
    extraExpense: Number(body?.scenario?.extraExpense ?? 0),
    salesChange: Number(body?.scenario?.salesChange ?? 0)
  };

  if (!Number.isFinite(openingCash) || openingCash < 0 || openingCash > 1_000_000_000_000) {
    throw Object.assign(new Error('Enter a valid current cash balance.'), { status: 400 });
  }
  if (!Number.isFinite(reserve) || reserve < 0 || reserve > 1_000_000_000_000) {
    throw Object.assign(new Error('Enter a valid reserve threshold.'), { status: 400 });
  }
  if (!Array.isArray(flows) || flows.length > 500) {
    throw Object.assign(new Error('Cash flow entries must be a list of at most 500 items.'), { status: 400 });
  }
  const cleanFlows = flows.map(flow => {
    const amount = Number(flow?.amount);
    const week = Number(flow?.week);
    if (!['in', 'out'].includes(flow?.type) || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000 || !Number.isInteger(week) || week < 0 || week > HORIZON) {
      throw Object.assign(new Error('Each cash flow needs a valid type, amount and week.'), { status: 400 });
    }
    return { type: flow.type, amount, week };
  });
  if (!Number.isInteger(scenario.delayWeeks) || scenario.delayWeeks < 0 || scenario.delayWeeks > 6 ||
      !Number.isFinite(scenario.extraExpense) || scenario.extraExpense < 0 || scenario.extraExpense > 1_000_000_000_000 ||
      !Number.isFinite(scenario.salesChange) || scenario.salesChange < -50 || scenario.salesChange > 20) {
    throw Object.assign(new Error('Scenario values are outside the supported range.'), { status: 400 });
  }
  return { openingCash, reserve, flows: cleanFlows, scenario };
}
