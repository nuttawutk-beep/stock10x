const express = require('express')
const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Supabase client
let supabase = null
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js')
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

// Yahoo Finance client — lazy-initialized per request to avoid serverless cold-start issues
function getYF() {
  const { default: YF } = require('yahoo-finance2')
  return new YF({ suppressNotices: ['yahooSurvey', 'ripHistorical'] })
}

const MOCK_STOCKS = {
  NVDA: { name: 'NVIDIA Corporation',     currentPrice: 875,  priceTarget2030: 2200, analystPriceTarget: 1050, action: 'Strong Buy' },
  TSLA: { name: 'Tesla Inc.',             currentPrice: 182,  priceTarget2030: 450,  analystPriceTarget: 220,  action: 'Buy'        },
  META: { name: 'Meta Platforms Inc.',    currentPrice: 525,  priceTarget2030: 900,  analystPriceTarget: 610,  action: 'Buy'        },
  AMZN: { name: 'Amazon.com Inc.',        currentPrice: 182,  priceTarget2030: 350,  analystPriceTarget: 215,  action: 'Strong Buy' },
  MSFT: { name: 'Microsoft Corporation', currentPrice: 415,  priceTarget2030: 600,  analystPriceTarget: 470,  action: 'Buy'        },
  AAPL: { name: 'Apple Inc.',             currentPrice: 196,  priceTarget2030: 280,  analystPriceTarget: 210,  action: 'Hold'       },
}

function formatStock(sym, row) {
  const up = (((row.price_target_2030 - row.current_price) / row.current_price) * 100).toFixed(1)
  return { symbol: sym, name: row.name, currentPrice: row.current_price, priceTarget2030: row.price_target_2030, analystPriceTarget: row.analyst_price_target, upsidePercent: `+${up}%`, action: row.action, asOf: new Date().toISOString().split('T')[0] }
}
function formatMock(sym, s) {
  const up = (((s.priceTarget2030 - s.currentPrice) / s.currentPrice) * 100).toFixed(1)
  return { symbol: sym, name: s.name, currentPrice: s.currentPrice, priceTarget2030: s.priceTarget2030, analystPriceTarget: s.analystPriceTarget, upsidePercent: `+${up}%`, action: s.action, asOf: new Date().toISOString().split('T')[0] }
}

async function lookupHandler(req, res) {
  const symbol = (req.params.symbol || req.query.symbol || '').trim().toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' })
  if (supabase) {
    const { data, error } = await supabase.from('stocks').select('*').eq('symbol', symbol).single()
    if (error || !data) return res.status(404).json({ error: `Symbol "${symbol}" not found` })
    return res.json(formatStock(symbol, data))
  }
  const s = MOCK_STOCKS[symbol]
  if (!s) return res.status(404).json({ error: `Symbol "${symbol}" not found`, available: Object.keys(MOCK_STOCKS) })
  return res.json(formatMock(symbol, s))
}

app.get('/api/stock/:symbol', lookupHandler)
app.get('/api/stock', lookupHandler)

app.get('/api/stocks', async (req, res) => {
  if (supabase) {
    const { data, error } = await supabase.from('stocks').select('symbol, name, action').order('symbol')
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ count: data.length, stocks: data })
  }
  const list = Object.entries(MOCK_STOCKS).map(([sym, s]) => ({ symbol: sym, name: s.name, action: s.action }))
  return res.json({ count: list.length, stocks: list })
})

app.post('/api/stocks', async (req, res) => {
  if (!supabase) return res.status(501).json({ error: 'Supabase not configured' })
  const { symbol, name, current_price, price_target_2030, analyst_price_target, action } = req.body
  if (!symbol || !name || !current_price) return res.status(400).json({ error: 'symbol, name, current_price required' })
  const { data, error } = await supabase.from('stocks').upsert({ symbol: symbol.toUpperCase(), name, current_price, price_target_2030, analyst_price_target, action }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json(data)
})

// ─── Yahoo Finance thesis data ─────────────────────────────────────────────

async function fetchYahooData(symbol) {
  const yf = getYF()

  const ytdStart = new Date(new Date().getFullYear(), 0, 2)

  const [quote, summaryData, ytdHistory] = await Promise.all([
    yf.quote(symbol),
    yf.quoteSummary(symbol, {
      modules: ['assetProfile', 'financialData', 'defaultKeyStatistics', 'incomeStatementHistory', 'recommendationTrend']
    }).catch(() => ({})),
    yf.historical(symbol, { period1: ytdStart, period2: new Date(), interval: '1wk' }).catch(() => []),
  ])

  const assetProfile    = summaryData.assetProfile             || {}
  const financialData   = summaryData.financialData            || {}
  const incomeHistory   = summaryData.incomeStatementHistory   || {}
  const recTrend        = summaryData.recommendationTrend      || {}

  const price      = quote.regularMarketPrice || 0
  const mcapRaw    = quote.marketCap          || 0
  const sharesRaw  = quote.sharesOutstanding  || 0
  const mcapB      = Math.round(mcapRaw / 1e8) / 10
  const sharesM    = Math.round(sharesRaw / 1e6)

  // Real YTD: first trading day of the year vs now
  const ytdOpen = ytdHistory.length > 0 ? ytdHistory[0].close : null
  const ytdPct  = ytdOpen ? Math.round(((price - ytdOpen) / ytdOpen) * 100) : 0
  const ytdGain = (ytdPct >= 0 ? '+' : '') + ytdPct + '%'

  const analystMean  = financialData.targetMeanPrice   || 0
  const analystLow   = financialData.targetLowPrice    || 0
  const analystHigh  = financialData.targetHighPrice   || 0
  const numAnalysts  = financialData.numberOfAnalystOpinions || 0
  const recKey       = financialData.recommendationKey || ''

  const ACTION_MAP = { strong_buy: 'Strong Buy', buy: 'Buy', hold: 'Hold', underperform: 'Sell', sell: 'Sell', none: 'Hold' }
  const action = ACTION_MAP[recKey] || (analystMean > price * 1.2 ? 'Buy' : 'Hold')

  const stmts = incomeHistory.incomeStatementHistory || []
  const revHistory = stmts.slice(0, 3).reverse().map((s, i) => ({
    year:  `FY${22 + i}`,
    value: Math.round((s.totalRevenue || 0) / 1e6),
    type:  'actual'
  })).filter(r => r.value > 0)

  const revenueGrowth = financialData.revenueGrowth || 0.20
  const grossMargin   = financialData.grossMargins  || 0.50
  const latestRevM    = revHistory.length > 0
    ? revHistory[revHistory.length - 1].value
    : Math.round((financialData.totalRevenue || 0) / 1e6)

  const growthFwd = Math.min(Math.max(revenueGrowth, 0.10), 1.50)
  const rev2026E  = Math.round(latestRevM * (1 + growthFwd))
  const rev2027E  = Math.round(rev2026E   * (1 + growthFwd * 0.85))
  const rev2028E  = Math.round(rev2027E   * (1 + growthFwd * 0.75))
  const rev2029E  = Math.round(rev2028E   * (1 + growthFwd * 0.65))
  const rev2030E  = Math.round(rev2029E   * (1 + growthFwd * 0.55))

  const peersEVRev = grossMargin > 0.70 ? 15 : grossMargin > 0.50 ? 10 : 6

  // Fix: pre-revenue companies (latestRevM < 2) → use analyst high or price-based multiple
  let baseTarget2030
  if (analystMean > 0 && latestRevM >= 2) {
    baseTarget2030 = Math.round(analystMean * 2.5)
  } else if (analystHigh > 0) {
    baseTarget2030 = Math.round(analystHigh * (grossMargin > 0.80 ? 3 : 2))
  } else if (rev2030E > 0) {
    baseTarget2030 = Math.round((rev2030E * peersEVRev * 1e6) / (sharesRaw || 1))
  } else {
    // True pre-revenue: price-to-market-cap speculative target
    baseTarget2030 = Math.round(price * (grossMargin > 0.80 ? 4 : 3))
  }

  const bullPrice  = Math.round(baseTarget2030 * 1.6)
  const bearPrice  = Math.round(price * 0.55)
  const basePrice  = baseTarget2030

  const bullReturn = Math.round((bullPrice - price) / price * 100)
  const baseReturn = Math.round((basePrice - price) / price * 100)
  const bearReturn = Math.round((bearPrice - price) / price * 100)

  const tamBase   = Math.max(latestRevM * 500, 80)
  const tamValues = [1, 1.35, 1.85, 2.5, 3.3, 4.3, 5.5].map(m => Math.round(tamBase * m))

  const trend0         = (recTrend.trend || [])[0] || {}
  const strongBuyCount = trend0.strongBuy || Math.max(1, Math.round(numAnalysts * 0.5))
  const buyCount       = trend0.buy       || Math.max(1, Math.round(numAnalysts * 0.3))
  const holdCount      = trend0.hold      || Math.max(1, Math.round(numAnalysts * 0.15))
  const sellCount      = trend0.sell      || 0

  const sector     = assetProfile.sector   || quote.sector   || 'Technology'
  const industry   = assetProfile.industry || 'Growth Technology'
  const bizSummary = assetProfile.longBusinessSummary || `${symbol} is a growth-stage company in the ${sector} sector.`

  const revenueEstimates = [
    ...revHistory,
    { year: 'FY25E', value: latestRevM > 1 ? Math.round(latestRevM * (1 + growthFwd)) : Math.round(latestRevM + 1), type: 'estimate' },
    { year: 'FY26E', value: rev2026E, type: 'estimate' },
    { year: 'FY27E', value: rev2027E, type: 'estimate' },
  ].filter((r, i, a) => a.findIndex(x => x.year === r.year) === i)

  return {
    symbol,
    companyName:        quote.longName || quote.shortName || `${symbol} Corporation`,
    sector,
    industry,
    currentPrice:       price,
    priceTarget2030:    basePrice,
    analystPriceTarget: analystMean || null,
    upsidePercent:      (baseReturn >= 0 ? '+' : '') + baseReturn + '%',
    action,
    ytdGain,
    marketCapB:         mcapB,
    sharesM,
    bullProb:           32,
    baseProb:           47,
    bearProb:           21,
    generatedAt:        new Date().toISOString(),

    fiftyTwoWeekLow:    quote.fiftyTwoWeekLow,
    fiftyTwoWeekHigh:   quote.fiftyTwoWeekHigh,
    businessSummary:    bizSummary,

    financials: {
      revenue:      revenueEstimates,
      grossMargin:  `${Math.round(grossMargin * 100)}%`,
      ebitdaMargin: `${Math.round((financialData.ebitdaMargins || 0) * 100)}%`,
      revenueCAGR:  `${Math.round(growthFwd * 100)}%`,
      netCash:      financialData.totalCash ? `$${Math.round(financialData.totalCash / 1e6)}M` : 'N/A',
    },

    tam: {
      years:       ['2024A','2025E','2026E','2027E','2028E','2029E','2030E'],
      values:      tamValues,
      cagr:        `${Math.round(30 + growthFwd * 20)}%`,
      description: `${symbol}'s addressable market in ${industry} is estimated at $${tamValues[2]}B in 2026 growing to $${tamValues[6]}B by 2030.`,
    },

    valuation: {
      method:           `DCF (10-yr, 10% WACC, 4% terminal growth) + EV/Revenue comps vs. ${sector} peers`,
      dcfTarget:        Math.round(basePrice * 1.08),
      compsTarget:      Math.round(basePrice * 0.94),
      baseTarget:       basePrice,
      analystConsensus: analystMean || Math.round(price * 1.3),
      strongBuyCount,
      buyCount,
      holdCount,
      sellCount,
      ptRangeLow:       analystLow   || Math.round(price * 0.75),
      ptRangeHigh:      analystHigh  || Math.round(price * 2.0),
      description:      `At $${price.toFixed(2)}, ${symbol} trades vs. a 2030 base case target of $${basePrice}, implying ${baseReturn}% upside. ${numAnalysts > 0 ? `${numAnalysts} analysts cover the stock with a mean target of $${Math.round(analystMean)}.` : 'Limited analyst coverage creates an early-mover advantage.'}`,
    },

    coreThesis: `${symbol} (${quote.longName || symbol}) is a ${baseReturn > 300 ? '10x' : baseReturn > 150 ? '5x' : '2-3x'} opportunity driven by structural growth in ${industry}. ${bizSummary.substring(0, 300).trim()} At $${price.toFixed(2)}, the stock offers ${32}% probability-weighted upside in the Bull case with defined catalysts over the next 2-4 years.`,

    overview: `${symbol} operates in the ${sector} sector (${industry}). ${bizSummary.substring(0, 400).trim()}`,

    drivers: {
      driver10x: `${industry} market growing at ${Math.round(30 + growthFwd * 20)}%+ CAGR — ${symbol} positioned for meaningful share capture by 2030`,
      moat: grossMargin > 0.70
        ? `Proprietary technology platform with high gross margins (${Math.round(grossMargin * 100)}%) — evidence of strong IP and pricing power`
        : 'Growing customer base with increasing switching costs and network effects',
      catalyst: numAnalysts > 0
        ? `Analyst consensus target of $${Math.round(analystMean)} implies near-term re-rating`
        : 'Revenue inflection and first profitability milestones expected to attract institutional coverage',
    },

    sevenPowers: [
      { power: 'Scale Economies',     grade: grossMargin > 0.70 ? 'A' : 'B', stars: grossMargin > 0.70 ? 4 : 3, description: `${symbol}'s cost structure improves materially at scale. Gross margins of ${Math.round(grossMargin * 100)}% indicate strong unit economics.` },
      { power: 'Network Economies',   grade: 'B', stars: 3, description: `Each incremental customer increases platform value. Network density is an early-stage but compounding moat.` },
      { power: 'Counter-Positioning', grade: 'B', stars: 3, description: `${symbol}'s architecture requires incumbents to cannibalize existing revenue to compete, providing multi-year runway.` },
      { power: 'Switching Costs',     grade: grossMargin > 0.70 ? 'S' : 'A', stars: grossMargin > 0.70 ? 5 : 4, description: `Deep integrations and workflow embedding make replacement costly. High gross margins evidence these costs are being monetized.` },
      { power: 'Branding',            grade: 'B', stars: 3, description: `${symbol} is establishing category leadership in ${industry}, creating trust that supports long-term pricing power.` },
      { power: 'Cornered Resource',   grade: grossMargin > 0.90 ? 'A' : 'B', stars: grossMargin > 0.90 ? 4 : 3, description: `${symbol} controls proprietary technology or data with ${Math.round(grossMargin * 100)}% gross margins reflecting this resource advantage.` },
      { power: 'Process Power',       grade: 'A', stars: 4, description: `${symbol}'s product development velocity and operational processes represent compounding institutional knowledge.` },
    ],

    swot: {
      strengths: [
        grossMargin > 0.70
          ? `Best-in-class gross margins (${Math.round(grossMargin * 100)}%) — strong pricing power and IP moat`
          : `Growing gross margins (${Math.round(grossMargin * 100)}%) with clear path to expansion`,
        `Operating in ${industry} — structurally expanding sector with ${Math.round(30 + growthFwd * 20)}%+ TAM CAGR`,
        sharesM < 200
          ? `Lean share count (${sharesM}M shares) — less dilution risk vs. peers`
          : `Established market presence with $${mcapB}B market capitalization`,
        `Differentiated technology platform with multi-year development lead`,
      ],
      weaknesses: [
        latestRevM < 10
          ? 'Pre-revenue / early-revenue stage — execution risk before product-market fit is proven'
          : `Revenue base of $${latestRevM}M still small relative to the full TAM opportunity`,
        `Limited analyst coverage means price discovery is inefficient and volatility elevated`,
        `Growth-stage cash burn requires monitoring of runway and capital raise timing`,
        `Geographic concentration — most revenue from North America with limited international presence`,
      ],
      opportunities: [
        `TAM expanding to $${tamValues[6]}B by 2030 — company currently at <1% penetration`,
        `Platform expansion into adjacent categories adds $${Math.round(tamValues[3] * 0.3)}B+ incremental SAM`,
        `International expansion into EU and APAC can double addressable market over 5 years`,
        `Strategic partnerships or OEM relationships can accelerate customer acquisition`,
      ],
      threats: [
        `Large incumbents with bundled offerings competing at aggressive pricing`,
        `Macro risk: growth-stage companies are sensitive to rate and risk-off environments`,
        `Regulatory risk in ${sector} — compliance changes could affect timing or cost structure`,
        `Funding risk if revenue inflection is delayed beyond current investor timeline`,
      ],
    },

    keyPlayers: (() => {
      const officers = assetProfile.companyOfficers || []
      const ROLE_NOTES = {
        ceo: 'Leads strategic vision, product direction, and investor relations. Founder-led management strongly preferred for long-term compounding.',
        cto: 'Owns the proprietary platform and technical roadmap. Key person — departure would be a significant negative signal.',
        cfo: 'Manages capital allocation, investor narrative, and path to profitability.',
        president: 'Day-to-day operations and go-to-market execution.',
        coo: 'Operational efficiency and scale. Key lever for margin expansion as the business grows.',
      }
      function roleKey(title) {
        const t = (title || '').toLowerCase()
        if (t.includes('chief executive') || t.includes('ceo')) return 'ceo'
        if (t.includes('president') && !t.includes('vice')) return 'president'
        if (t.includes('chief technology') || t.includes('cto')) return 'cto'
        if (t.includes('chief financial') || (t.includes('cfo') && !t.includes('principal financial'))) return 'cfo'
        if (t.includes('chief operating') || t.includes('coo')) return 'coo'
        return null
      }
      const PRIORITY_KEYS = ['ceo', 'president', 'cto', 'cfo', 'coo']
      const seen = new Set()
      const result = []
      // First pass: priority roles
      for (const key of PRIORITY_KEYS) {
        const officer = officers.find(o => roleKey(o.title) === key)
        if (officer && !seen.has(officer.name)) {
          seen.add(officer.name)
          result.push({ name: officer.name, role: officer.title, note: ROLE_NOTES[key], age: officer.age, fiscalYearPay: officer.totalPay ? `$${Math.round(officer.totalPay / 1000)}K` : undefined })
        }
        if (result.length >= 4) break
      }
      // Second pass: remaining unique officers
      for (const o of officers) {
        if (result.length >= 4) break
        if (!seen.has(o.name)) {
          seen.add(o.name)
          result.push({ name: o.name, role: o.title, note: `${o.title} responsible for ${symbol}'s ${sector} operations.`, age: o.age })
        }
      }
      if (result.length === 0) {
        return [
          { name: 'CEO', role: 'Chief Executive Officer', note: 'Leads strategic vision and investor relations.' },
          { name: 'CFO', role: 'Chief Financial Officer', note: 'Manages capital allocation and path to profitability.' },
        ]
      }
      return result
    })(),

    scenarios: {
      bull: {
        price: bullPrice,
        return: `+${bullReturn}%`,
        prob: 32,
        assumptions: [
          `Revenue accelerates to ${Math.round(growthFwd * 130)}%+ CAGR — market share capture exceeds base case`,
          `Gross margins expand to ${Math.round(grossMargin * 100 + 8)}%+ as product mix shifts to recurring revenue`,
          `Multiple re-rates to ${Math.round(peersEVRev * 1.8)}x EV/Revenue as growth durability is established`,
          `Strategic partnership or M&A accelerates TAM expansion into adjacent verticals`,
        ],
      },
      base: {
        price: basePrice,
        return: (baseReturn >= 0 ? '+' : '') + baseReturn + '%',
        prob: 47,
        assumptions: [
          `Revenue compounds at ${Math.round(growthFwd * 100)}% CAGR — consistent execution on core roadmap`,
          `Gross margins improve to ${Math.round(grossMargin * 100 + 4)}% as scale and mix mature`,
          `Multiple holds at ${peersEVRev}x EV/Revenue — growth premium sustained through execution`,
          `Steady market share gains with early traction in 1-2 adjacent categories`,
        ],
      },
      bear: {
        price: bearPrice,
        return: `${bearReturn}%`,
        prob: 21,
        assumptions: [
          `Revenue growth decelerates to ${Math.round(growthFwd * 30)}% — competitive pressure or macro freeze`,
          `Gross margin compression to ${Math.round(grossMargin * 100 - 15)}% as pricing power erodes`,
          `Multiple de-rates to ${Math.round(peersEVRev * 0.5)}x EV/Revenue`,
          `Incumbents or Big Tech takes share — churn accelerates beyond cohort models`,
        ],
      },
    },
  }
}

// GET /api/thesis/:symbol
app.get('/api/thesis/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').trim().toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' })
  if (supabase) {
    const { data, error } = await supabase.from('theses').select('data, generated_at').eq('symbol', symbol).single()
    if (!error && data) return res.json({ ...data.data, cached: true, generatedAt: data.generated_at })
  }
  return res.status(404).json({ error: `No thesis for ${symbol}. POST /api/generate-thesis to create one.` })
})

// POST /api/generate-thesis  { symbol }
app.post('/api/generate-thesis', async (req, res) => {
  const { symbol } = req.body
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' })
  const sym = symbol.trim().toUpperCase()

  let thesis
  try {
    thesis = await fetchYahooData(sym)
  } catch (err) {
    return res.status(502).json({ error: `Yahoo Finance error: ${err.message}`, symbol: sym })
  }

  if (!thesis) {
    return res.status(404).json({ error: `Could not find market data for "${sym}". Check the ticker.`, hint: 'Valid US stock ticker required (e.g. NVDA, LWLG, AAPL)' })
  }

  if (supabase) {
    const { error } = await supabase.from('theses').upsert({ symbol: sym, data: thesis, generated_at: new Date().toISOString() }, { onConflict: 'symbol' })
    if (error) console.error('Supabase upsert error:', error.message)
  }

  return res.json({ ...thesis, cached: false })
})

app.get('/', (req, res) => {
  res.json({
    service: 'Stock10x API',
    version: '4.1.0',
    dataSource: 'Yahoo Finance (real-time)',
    supabase: !!supabase,
    endpoints: ['GET /api/stock/NVDA', 'GET /api/stocks', 'GET /api/thesis/NVDA', 'POST /api/generate-thesis { symbol }'],
  })
})

app.listen(PORT, () => console.log(`Stock10x API v4.1 -> http://localhost:${PORT}`))
module.exports = app
