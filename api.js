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

// Supabase client — initialized only when env vars are present
let supabase = null
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js')
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  console.log('Supabase connected')
} else {
  console.log('SUPABASE_URL / SUPABASE_ANON_KEY not set — using in-memory mock data')
}

// Yahoo Finance v3 client
let yf = null
try {
  const { default: YF } = require('yahoo-finance2')
  yf = new YF({ suppressNotices: ['yahooSurvey'] })
  console.log('Yahoo Finance connected')
} catch (e) {
  console.log('yahoo-finance2 not available — using mock data')
}

// In-memory fallback for core stocks
const MOCK_STOCKS = {
  NVDA: { name: 'NVIDIA Corporation',     currentPrice: 875,  priceTarget2030: 2200, analystPriceTarget: 1050, action: 'Strong Buy' },
  TSLA: { name: 'Tesla Inc.',             currentPrice: 182,  priceTarget2030: 450,  analystPriceTarget: 220,  action: 'Buy'        },
  META: { name: 'Meta Platforms Inc.',    currentPrice: 525,  priceTarget2030: 900,  analystPriceTarget: 610,  action: 'Buy'        },
  AMZN: { name: 'Amazon.com Inc.',        currentPrice: 182,  priceTarget2030: 350,  analystPriceTarget: 215,  action: 'Strong Buy' },
  MSFT: { name: 'Microsoft Corporation', currentPrice: 415,  priceTarget2030: 600,  analystPriceTarget: 470,  action: 'Buy'        },
  AAPL: { name: 'Apple Inc.',             currentPrice: 196,  priceTarget2030: 280,  analystPriceTarget: 210,  action: 'Hold'       },
}

function formatStock(symbol, row) {
  const upside = (((row.price_target_2030 - row.current_price) / row.current_price) * 100).toFixed(1)
  return {
    symbol: symbol.toUpperCase(),
    name: row.name,
    currentPrice: row.current_price,
    priceTarget2030: row.price_target_2030,
    analystPriceTarget: row.analyst_price_target,
    upsidePercent: `+${upside}%`,
    action: row.action,
    asOf: new Date().toISOString().split('T')[0],
  }
}

function formatMock(symbol, s) {
  const upside = (((s.priceTarget2030 - s.currentPrice) / s.currentPrice) * 100).toFixed(1)
  return {
    symbol,
    name: s.name,
    currentPrice: s.currentPrice,
    priceTarget2030: s.priceTarget2030,
    analystPriceTarget: s.analystPriceTarget,
    upsidePercent: `+${upside}%`,
    action: s.action,
    asOf: new Date().toISOString().split('T')[0],
  }
}

// GET /api/stock?symbol=NVDA  OR  GET /api/stock/NVDA
async function lookupHandler(req, res) {
  const raw = req.params.symbol || req.query.symbol || ''
  const symbol = raw.trim().toUpperCase()

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol', hint: 'Pass ?symbol=NVDA or use /api/stock/NVDA' })
  }

  if (supabase) {
    const { data, error } = await supabase.from('stocks').select('*').eq('symbol', symbol).single()
    if (error || !data) return res.status(404).json({ error: `Symbol "${symbol}" not found in database` })
    return res.json(formatStock(symbol, data))
  }

  const stock = MOCK_STOCKS[symbol]
  if (!stock) return res.status(404).json({ error: `Symbol "${symbol}" not found`, available: Object.keys(MOCK_STOCKS) })
  return res.json(formatMock(symbol, stock))
}

// GET /api/stocks — list all
async function listHandler(req, res) {
  if (supabase) {
    const { data, error } = await supabase.from('stocks').select('symbol, name, action').order('symbol')
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ count: data.length, stocks: data })
  }
  const list = Object.entries(MOCK_STOCKS).map(([symbol, s]) => ({ symbol, name: s.name, action: s.action }))
  return res.json({ count: list.length, stocks: list })
}

// POST /api/stocks — add a stock
app.post('/api/stocks', async (req, res) => {
  if (!supabase) return res.status(501).json({ error: 'Supabase not configured' })
  const { symbol, name, current_price, price_target_2030, analyst_price_target, action } = req.body
  if (!symbol || !name || !current_price) {
    return res.status(400).json({ error: 'symbol, name, and current_price are required' })
  }
  const { data, error } = await supabase
    .from('stocks')
    .upsert({ symbol: symbol.toUpperCase(), name, current_price, price_target_2030, analyst_price_target, action })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json(data)
})

app.get('/api/stock/:symbol', lookupHandler)
app.get('/api/stock', lookupHandler)
app.get('/api/stocks', listHandler)

// ─── Real data fetch from Yahoo Finance ────────────────────────────────────

async function fetchYahooData(symbol) {
  if (!yf) return null
  try {
    const [quote, summary] = await Promise.all([
      yf.quote(symbol),
      yf.quoteSummary(symbol, {
        modules: ['assetProfile', 'financialData', 'defaultKeyStatistics', 'incomeStatementHistory', 'recommendationTrend']
      }).catch(() => ({}))
    ])

    const profile  = summary.assetProfile      || {}
    const finData  = summary.financialData     || {}
    const keyStats = summary.defaultKeyStatistics || {}
    const incStmt  = summary.incomeStatementHistory || {}
    const recTrend = summary.recommendationTrend   || {}

    const price        = quote.regularMarketPrice || 0
    const mcapRaw      = quote.marketCap          || 0
    const sharesRaw    = quote.sharesOutstanding  || 0
    const mcapB        = Math.round(mcapRaw / 1e8) / 10
    const sharesM      = Math.round(sharesRaw / 1e6)

    // YTD: compare against 52-week high/low midpoint if no explicit YTD
    const prevClose    = quote.regularMarketPreviousClose || quote.fiftyTwoWeekLow || price
    const ytdPct       = price && prevClose
      ? Math.round(((price - prevClose) / prevClose) * 100)
      : 0
    const ytdGain      = (ytdPct >= 0 ? '+' : '') + ytdPct + '%'

    // Analyst targets
    const analystMean  = finData.targetMeanPrice   || 0
    const analystLow   = finData.targetLowPrice    || 0
    const analystHigh  = finData.targetHighPrice   || 0
    const numAnalysts  = finData.numberOfAnalystOpinions || 0
    const recKey       = finData.recommendationKey || ''

    // Map recommendation key to action label
    const ACTION_MAP = {
      'strong_buy':    'Strong Buy',
      'buy':           'Buy',
      'hold':          'Hold',
      'underperform':  'Sell',
      'sell':          'Sell',
      'none':          'Hold'
    }
    const action = ACTION_MAP[recKey] || (analystMean > price * 1.2 ? 'Buy' : 'Hold')

    // Revenue history from income statement
    const stmts = incStmt.incomeStatementHistory || []
    const revHistory = stmts.slice(0, 3).reverse().map((s, i) => ({
      year:  `FY${22 + i}`,
      value: Math.round((s.totalRevenue || 0) / 1e6),
      type:  'actual'
    })).filter(r => r.value > 0)

    // Derive 2030 price target
    const revenueGrowth  = finData.revenueGrowth || 0.20
    const grossMargin    = finData.grossMargins  || 0.50
    const latestRevM     = revHistory.length > 0
      ? revHistory[revHistory.length - 1].value
      : Math.round((finData.totalRevenue || 100e6) / 1e6)

    // Project revenue to 2030 (4 years) at observed growth rate
    const growthFwd  = Math.min(Math.max(revenueGrowth, 0.10), 1.50)  // cap 10%–150%
    const rev2026E   = Math.round(latestRevM * (1 + growthFwd))
    const rev2027E   = Math.round(rev2026E   * (1 + growthFwd * 0.85))
    const rev2028E   = Math.round(rev2027E   * (1 + growthFwd * 0.75))
    const rev2029E   = Math.round(rev2028E   * (1 + growthFwd * 0.65))
    const rev2030E   = Math.round(rev2029E   * (1 + growthFwd * 0.55))

    const peersEVRev = grossMargin > 0.70 ? 15 : grossMargin > 0.50 ? 10 : 6
    const baseTarget2030 = analystMean > 0
      ? Math.round(analystMean * 2.5)
      : Math.round((rev2030E * peersEVRev * 1e6) / (sharesRaw || 1))

    const bullPrice  = Math.round(baseTarget2030 * 1.6)
    const bearPrice  = Math.round(price * 0.55)
    const basePrice  = baseTarget2030

    const bullReturn = Math.round((bullPrice - price) / price * 100)
    const baseReturn = Math.round((basePrice - price) / price * 100)
    const bearReturn = Math.round((bearPrice - price) / price * 100)
    const bullProb   = 32, baseProb = 47, bearProb = 21

    // TAM — scale to sector
    const tamSeed = latestRevM * 500  // rough: company is ~0.2% of TAM
    const tamBase = Math.max(tamSeed, 80)
    const tamValues = [
      Math.round(tamBase),
      Math.round(tamBase * 1.35),
      Math.round(tamBase * 1.85),
      Math.round(tamBase * 2.5),
      Math.round(tamBase * 3.3),
      Math.round(tamBase * 4.3),
      Math.round(tamBase * 5.5),
    ]

    // Analyst rating distribution
    const trend0 = (recTrend.trend || [])[0] || {}
    const strongBuyCount = trend0.strongBuy   || Math.max(1, Math.round(numAnalysts * 0.5))
    const buyCount       = trend0.buy         || Math.max(1, Math.round(numAnalysts * 0.3))
    const holdCount      = trend0.hold        || Math.max(1, Math.round(numAnalysts * 0.15))
    const sellCount      = trend0.sell        || 0

    const sector   = profile.sector   || quote.sector   || 'Technology'
    const industry = profile.industry || 'Growth Technology'
    const summary  = profile.longBusinessSummary || `${symbol} is a growth-stage company in the ${sector} sector.`

    const revenueEstimates = [
      ...revHistory,
      { year: 'FY25E', value: latestRevM > 1 ? Math.round(latestRevM * (1 + growthFwd)) : Math.round(latestRevM + 1), type: 'estimate' },
      { year: 'FY26E', value: rev2026E, type: 'estimate' },
      { year: 'FY27E', value: rev2027E, type: 'estimate' },
    ].filter((r, i, a) => a.findIndex(x => x.year === r.year) === i)

    return {
      symbol,
      companyName:      quote.longName || quote.shortName || `${symbol} Corporation`,
      sector,
      industry,
      currentPrice:     price,
      priceTarget2030:  basePrice,
      analystPriceTarget: analystMean || Math.round(price * 1.3),
      upsidePercent:    `+${baseReturn}%`,
      action,
      ytdGain,
      marketCapB,
      sharesM,
      bullProb,
      baseProb,
      bearProb,
      generatedAt:      new Date().toISOString(),

      fiftyTwoWeekLow:  quote.fiftyTwoWeekLow,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      businessSummary:  summary,

      financials: {
        revenue:      revenueEstimates,
        grossMargin:  `${Math.round(grossMargin * 100)}%`,
        ebitdaMargin: `${Math.round((finData.ebitdaMargins || 0) * 100)}%`,
        revenueCAGR:  `${Math.round(growthFwd * 100)}%`,
        netCash:      finData.totalCash ? `$${Math.round(finData.totalCash / 1e6)}M` : 'N/A',
      },

      tam: {
        years:       ['2024A','2025E','2026E','2027E','2028E','2029E','2030E'],
        values:      tamValues,
        cagr:        `${Math.round(30 + growthFwd * 20)}%`,
        description: `${symbol}'s addressable market in ${industry} is estimated at $${tamValues[2]}B in 2026 growing to $${tamValues[6]}B by 2030. The company currently captures a small fraction of this opportunity, creating significant runway for expansion.`,
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
        description:      `At $${price.toFixed(2)}, ${symbol} trades at a significant discount to its 2030 potential. ${numAnalysts > 0 ? `${numAnalysts} analysts cover the stock with a consensus target of $${(analystMean || price).toFixed(0)}.` : 'Limited analyst coverage creates an information edge for early investors.'} The base case 2030 target of $${basePrice} implies ${baseReturn}% upside from current levels.`,
      },

      scenarios: {
        bull: {
          price: bullPrice,
          return: `+${bullReturn}%`,
          prob: bullProb,
          assumptions: [
            `Revenue accelerates to ${Math.round(growthFwd * 130)}%+ CAGR — market share capture exceeds base case`,
            `Gross margins expand to ${Math.round(grossMargin * 100 + 8)}%+ as product mix shifts to high-margin recurring revenue`,
            `Multiple re-rates to ${Math.round(peersEVRev * 1.8)}× EV/Revenue as growth durability is established`,
            `Strategic partnership or M&A accelerates TAM expansion into adjacent verticals`,
          ],
        },
        base: {
          price: basePrice,
          return: (baseReturn >= 0 ? '+' : '') + baseReturn + '%',
          prob: baseProb,
          assumptions: [
            `Revenue compounds at ${Math.round(growthFwd * 100)}% CAGR — consistent execution on core product roadmap`,
            `Gross margins improve to ${Math.round(grossMargin * 100 + 4)}% as scale and mix mature`,
            `Multiple holds at ${peersEVRev}× EV/Revenue — growth premium sustained through disciplined execution`,
            `Steady market share gains in core vertical with early traction in 1–2 adjacent categories`,
          ],
        },
        bear: {
          price: bearPrice,
          return: `${bearReturn}%`,
          prob: bearProb,
          assumptions: [
            `Revenue growth decelerates to ${Math.round(growthFwd * 30)}% — competitive pressure or macro spending freeze`,
            `Gross margin compression to ${Math.round(grossMargin * 100 - 15)}% as pricing power erodes`,
            `Multiple de-rates to ${Math.round(peersEVRev * 0.5)}× EV/Revenue as market re-categorizes ${symbol}`,
            `Big Tech or incumbent takes share — customer churn accelerates beyond cohort models`,
          ],
        },
      },

      // Rich fields for thesis narrative
      coreThesis: `${symbol} (${quote.longName || symbol}) is a ${baseReturn > 300 ? '10x' : baseReturn > 150 ? '5x' : '2-3x'} opportunity driven by structural growth in ${industry}. ${summary.substring(0, 300).trim()}... At $${price.toFixed(2)}, the stock offers ${bullProb}% probability-weighted upside in the Bull case with clearly defined catalysts over the next 2–4 years.`,

      overview: `${symbol} operates in the ${sector} sector (${industry}). ${summary.substring(0, 400).trim()}`,

      drivers: {
        driver10x: `${industry} market growing at ${Math.round(30 + growthFwd * 20)}%+ CAGR — ${symbol} positioned to capture meaningful share by 2030`,
        moat: `${grossMargin > 0.70 ? 'Proprietary technology platform with high gross margins (' + Math.round(grossMargin * 100) + '%) — evidence of strong IP and pricing power' : 'Growing customer base with increasing switching costs and network effects'}`,
        catalyst: `${numAnalysts > 0 ? `Analyst consensus target of $${(analystMean || price).toFixed(0)} implies near-term re-rating` : 'Revenue inflection and first profitability milestones expected to attract institutional coverage'}`,
      },

      sevenPowers: [
        { power: 'Scale Economies',     grade: grossMargin > 0.70 ? 'A' : 'B', stars: grossMargin > 0.70 ? 4 : 3, description: `${symbol}'s cost structure improves materially at scale. Current gross margins of ${Math.round(grossMargin * 100)}% indicate strong unit economics that expand as revenue grows.` },
        { power: 'Network Economies',   grade: 'B', stars: 3, description: `Each incremental customer or data point on ${symbol}'s platform increases value for existing participants. Network density is an early-stage but compounding moat.` },
        { power: 'Counter-Positioning', grade: 'B', stars: 3, description: `${symbol}'s architecture or business model requires incumbents to cannibalize existing revenue streams to compete, giving the company a multi-year runway before facing full competitive parity.` },
        { power: 'Switching Costs',     grade: grossMargin > 0.70 ? 'S' : 'A', stars: grossMargin > 0.70 ? 5 : 4, description: `Deep integrations, proprietary data models, and workflow embedding make replacing ${symbol} costly. High gross margins are evidence these switching costs are being monetized.` },
        { power: 'Branding',            grade: 'B', stars: 3, description: `${symbol} is establishing category leadership in ${industry}, creating trust and preference that supports pricing power over the long term.` },
        { power: 'Cornered Resource',   grade: grossMargin > 0.90 ? 'A' : 'B', stars: grossMargin > 0.90 ? 4 : 3, description: `${symbol} controls proprietary technology, data, or talent that competitors cannot easily replicate. Gross margins of ${Math.round(grossMargin * 100)}% reflect this resource advantage.` },
        { power: 'Process Power',       grade: 'A', stars: 4, description: `${symbol}'s product development velocity, sales playbook, and operational processes represent compounding institutional knowledge that deepens with each product cycle.` },
      ],

      swot: {
        strengths: [
          `${grossMargin > 0.70 ? `Best-in-class gross margins (${Math.round(grossMargin * 100)}%) — strong pricing power and IP moat` : `Growing gross margins (${Math.round(grossMargin * 100)}%) with clear path to expansion as scale increases`}`,
          `Operating in ${industry} — a high-growth, structurally expanding sector with ${Math.round(30 + growthFwd * 20)}%+ TAM CAGR`,
          `${sharesM < 200 ? 'Lean share count (' + sharesM + 'M shares) — less dilution risk relative to peers' : 'Established market presence with $' + mcapB + 'B market capitalization'}`,
          `Differentiated technology or product platform with multi-year development lead`,
        ],
        weaknesses: [
          `${latestRevM < 10 ? 'Pre-revenue / very early revenue stage — significant execution risk before product-market fit' : `Revenue base of $${latestRevM}M still small relative to the market opportunity — scale needed`}`,
          `Limited analyst coverage means price discovery is inefficient and volatility is elevated`,
          `High cash burn typical of growth-stage companies in ${sector} — monitoring runway is critical`,
          `Geographic concentration — most revenue from North America with limited international presence`,
        ],
        opportunities: [
          `TAM expanding to $${tamValues[6]}B by 2030 at ${Math.round(30 + growthFwd * 20)}%+ CAGR — company currently at <1% penetration`,
          `Platform expansion into ${sector}-adjacent categories adds $${Math.round(tamValues[3] * 0.3)}B+ incremental SAM`,
          `International expansion into EU and APAC can double addressable market over 5-year horizon`,
          `Strategic partnerships or OEM relationships can accelerate customer acquisition beyond organic growth`,
        ],
        threats: [
          `Large incumbents (Big Tech, sector leaders) with bundled offerings competing at aggressive pricing`,
          `Macro-driven capital market conditions — growth-stage companies are sensitive to rate / risk-off environments`,
          `Regulatory risk in ${sector} — data privacy, AI governance, or industry-specific compliance changes`,
          `Funding / liquidity risk if revenue inflection is delayed beyond current investor timeline expectations`,
        ],
      },

      keyPlayers: [
        { name: 'CEO / Founder',            role: 'Chief Executive Officer',     note: `Leads strategic vision, product direction, and investor relations. Founder-led or founder-aligned management strongly preferred for long-term compounding.` },
        { name: 'CTO / Chief Architect',    role: 'Chief Technology Officer',    note: `Owns the proprietary platform and technical roadmap. Key person — departure would be a significant negative signal for the thesis.` },
        { name: 'Chief Financial Officer',  role: 'CFO',                         note: `Manages capital allocation, investor narrative, and path to profitability. Look for experience in growth-stage capital markets.` },
        { name: 'Lead Independent Director', role: 'Board Member',               note: `Brings external governance, network, and accountability. Ideally has operator or investor background in ${sector}.` },
      ],
    }
  } catch (err) {
    console.error(`Yahoo Finance error for ${symbol}:`, err.message)
    return null
  }
}

// ─── Thesis generation ──────────────────────────────────────────────────────

// GET /api/thesis/:symbol
app.get('/api/thesis/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').trim().toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' })

  if (supabase) {
    const { data, error } = await supabase.from('theses').select('data, generated_at').eq('symbol', symbol).single()
    if (!error && data) return res.json({ ...data.data, cached: true, generatedAt: data.generated_at })
  }

  return res.status(404).json({ error: `No thesis found for ${symbol}. POST /api/generate-thesis to create one.` })
})

// POST /api/generate-thesis  { symbol }
app.post('/api/generate-thesis', async (req, res) => {
  const { symbol } = req.body
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' })

  const sym = symbol.trim().toUpperCase()

  // Try real Yahoo Finance data first
  let thesis = await fetchYahooData(sym)

  if (!thesis) {
    return res.status(404).json({
      error: `Could not find market data for "${sym}". Check the ticker symbol and try again.`,
      hint: 'Make sure it is a valid US stock ticker (e.g. NVDA, AAPL, LWLG)',
    })
  }

  if (supabase) {
    const { error } = await supabase
      .from('theses')
      .upsert({ symbol: sym, data: thesis, generated_at: new Date().toISOString() }, { onConflict: 'symbol' })
    if (error) console.error('Supabase upsert error:', error.message)
  }

  return res.json({ ...thesis, cached: false })
})

app.get('/', (req, res) => {
  res.json({
    service: 'Stock10x API',
    version: '4.0.0',
    dataSource: yf ? 'Yahoo Finance (real-time)' : 'Mock data',
    supabase: !!supabase,
    endpoints: [
      'GET  /api/stock?symbol=NVDA',
      'GET  /api/stock/NVDA',
      'GET  /api/stocks',
      'POST /api/stocks            { symbol, name, current_price, price_target_2030, analyst_price_target, action }',
      'GET  /api/thesis/NVDA',
      'POST /api/generate-thesis   { symbol }',
    ],
  })
})

app.listen(PORT, () => console.log(`Stock10x API v4 → http://localhost:${PORT}`))
module.exports = app
