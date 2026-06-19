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

// In-memory fallback (used when Supabase is not configured)
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
    const { data, error } = await supabase
      .from('stocks')
      .select('*')
      .eq('symbol', symbol)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: `Symbol "${symbol}" not found in database` })
    }
    return res.json(formatStock(symbol, data))
  }

  const stock = MOCK_STOCKS[symbol]
  if (!stock) {
    return res.status(404).json({ error: `Symbol "${symbol}" not found`, available: Object.keys(MOCK_STOCKS) })
  }
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

// POST /api/stocks — add a stock (Supabase only)
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

// ─── Thesis generation ─────────────────────────────────────────────────────

function generateMockThesis(symbol) {
  const s = symbol.toUpperCase()
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  h = h || 1

  const pick = (arr) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return arr[h % arr.length] }
  const num  = (min, max) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return min + (h % (max - min + 1)) }

  const SECTORS = ['AI Infrastructure', 'Cloud Computing', 'Semiconductors', 'Fintech', 'Clean Energy', 'Biotech', 'Enterprise SaaS', 'E-Commerce', 'Cybersecurity', 'Digital Media']
  const sector = pick(SECTORS)

  const curPrice  = num(8, 500)
  const bullMult  = num(5, 12)
  const baseMult  = num(25, 50) / 10
  const bearMult  = num(7, 13) / 10

  const bullPrice = Math.round(curPrice * bullMult)
  const basePrice = Math.round(curPrice * baseMult)
  const bearPrice = Math.round(curPrice * bearMult)

  const bullProb = num(28, 42)
  const bearProb = num(15, 25)
  const baseProb = 100 - bullProb - bearProb

  const bullReturn = Math.round((bullPrice - curPrice) / curPrice * 100)
  const baseReturn = Math.round((basePrice - curPrice) / curPrice * 100)
  const bearReturn = Math.round((bearPrice - curPrice) / curPrice * 100)

  const tamBase   = num(80, 200)
  const tamValues = [tamBase, Math.round(tamBase*1.4), Math.round(tamBase*2.0), Math.round(tamBase*2.8), Math.round(tamBase*3.8), Math.round(tamBase*5.0), Math.round(tamBase*6.5)]

  const rev0 = num(30, 100)
  const revenues = [
    { year: 'FY23',  value: rev0,                                              type: 'actual'   },
    { year: 'FY24',  value: Math.round(rev0 * (18 + num(0, 10)) / 10),         type: 'actual'   },
    { year: 'FY25E', value: Math.round(rev0 * (35 + num(0, 15)) / 10),         type: 'estimate' },
    { year: 'FY26E', value: Math.round(rev0 * (60 + num(0, 20)) / 10),         type: 'estimate' },
    { year: 'FY27E', value: Math.round(rev0 * (100 + num(0, 30)) / 10),        type: 'estimate' },
  ]

  const gm            = num(55, 80)
  const ebitdaMargin  = num(15, 40)
  const revenueCAGR   = num(65, 120)
  const analystTarget = Math.round(basePrice * (75 + num(0, 15)) / 100)
  const strongBuys    = num(8, 18)
  const buys          = num(3, 10)
  const holds         = num(1, 5)
  const sells         = num(0, 2)

  return {
    symbol: s,
    companyName: `${s} Corporation`,
    sector,
    currentPrice: curPrice,
    priceTarget2030: basePrice,
    analystPriceTarget: analystTarget,
    upsidePercent: `+${baseReturn}%`,
    action: pick(['Strong Buy', 'Strong Buy', 'Buy', 'Buy', 'Hold']),
    generatedAt: new Date().toISOString(),

    overview: `${s} is a high-growth ${sector} company positioned at the intersection of structural megatrends in AI, cloud, and digital transformation. The company has demonstrated exceptional capital efficiency with revenue growing at ${revenueCAGR}%+ CAGR. ${s}'s proprietary platform creates deep competitive moats through switching costs, network effects, and a cornered resource position in talent and data.`,

    coreThesis: `${s} represents a ${bullMult}x opportunity by 2030 driven by three compounding tailwinds: (1) secular shift of enterprise workloads to ${sector.toLowerCase()} infrastructure growing at 30%+ CAGR, (2) proprietary technology creating lasting switching costs and network effects, and (3) expanding TAM as digital transformation becomes table-stakes across every industry. At $${curPrice}, the stock offers asymmetric risk/reward: ${bullProb}% probability-weighted upside of +${bullReturn}% in the Bull case vs. only ${bearProb}% probability of the Bear scenario.`,

    drivers: {
      driver10x: `${sector} infrastructure spend growing 35%+ CAGR — ${s} positioned to capture 15%+ market share by 2030`,
      moat: `Proprietary platform with deep switching costs, ${num(200,1500)} enterprise customers, and growing network effects`,
      catalyst: `Next ${num(2,4)} earnings cycles expected to show revenue acceleration and first signs of operating leverage`,
    },

    sevenPowers: [
      { power: 'Scale Economies',      grade: pick(['S','A','A']), stars: num(4,5), description: `${s}'s cost structure improves materially at scale — fixed R&D and infrastructure costs spread across a growing customer base, creating a widening efficiency advantage. At $${revenues[4].value}M+ revenue, S&M ratios improve to class-leading levels.` },
      { power: 'Network Economies',    grade: pick(['A','A','B']), stars: num(3,5), description: `Each new customer on ${s}'s platform increases value for all existing customers through shared benchmarks and ecosystem integrations. Network effects compound silently but create the most durable moat in the system.` },
      { power: 'Counter-Positioning',  grade: pick(['A','B','B']), stars: num(2,4), description: `${s}'s architecture requires incumbents to cannibalize existing revenue streams to compete effectively. This structural hesitance gives ${s} a multi-year runway to compound growth before facing true competitive parity.` },
      { power: 'Switching Costs',      grade: pick(['S','A','A']), stars: num(4,5), description: `Deep workflow integrations, proprietary data models, and extensive configurations make replacing ${s} costly in time, risk, and capital. Average customer LTV exceeds ${num(3,8)}x CAC — evidence switching costs are being monetized.` },
      { power: 'Branding',             grade: pick(['A','B','B']), stars: num(3,4), description: `${s} is establishing itself as the category-defining platform in ${sector.toLowerCase()}, creating trust and preference that supports pricing power. NPS scores in the top quartile of software peers.` },
      { power: 'Cornered Resource',    grade: pick(['A','B','C']), stars: num(2,4), description: `${s} controls critical engineering talent, proprietary training datasets, and ${num(15,80)}+ issued patents that competitors cannot easily replicate or acquire at any price.` },
      { power: 'Process Power',        grade: pick(['A','A','B']), stars: num(3,5), description: `${s}'s product development velocity, enterprise sales playbook, and customer success processes represent compounding institutional knowledge that deepens with every product cycle and customer cohort.` },
    ],

    swot: {
      strengths: [
        `Market-leading position in ${sector.toLowerCase()} with ${num(15,40)}%+ share in core vertical`,
        `Proprietary technology platform with ${num(2,5)}-year development lead over nearest competitor`,
        `Best-in-class gross margins (${gm}%) indicating strong pricing power and product differentiation`,
        `World-class management team with ${num(10,30)}%+ founder ownership aligned with long-term value creation`,
      ],
      weaknesses: [
        `High customer concentration — top ${num(8,15)} customers represent ${num(35,55)}% of ARR`,
        `Significant ongoing R&D investment (${num(25,45)}% of revenue) required to maintain technology lead`,
        `Limited international expansion — ${num(70,90)}% of revenue from North America`,
        `Elevated cash burn — runway of ${num(18,48)} months at current investment pace`,
      ],
      opportunities: [
        `Global ${sector.toLowerCase()} market expanding to $${tamValues[6]}B+ by 2030 at ${num(28,42)}% CAGR`,
        `Platform expansion into ${num(3,6)} adjacent categories adds $${num(500,2000)}M+ incremental TAM`,
        `Enterprise segment <${num(3,8)}% penetrated — massive whitespace in Fortune 2000`,
        `International expansion into EU and APAC can double TAM over 5-year horizon`,
      ],
      threats: [
        `Big Tech (MSFT, GOOG, AMZN) competing with bundled ${sector.toLowerCase()} offerings at aggressive pricing`,
        `Macro-driven enterprise IT budget freezes could slow deal cycle velocity`,
        `Regulatory scrutiny — data privacy, AI governance, and antitrust exposure in key markets`,
        `Key person dependency — loss of founding team or CTO would negatively impact product velocity`,
      ],
    },

    tam: {
      years:  ['2024A','2025E','2026E','2027E','2028E','2029E','2030E'],
      values: tamValues,
      cagr:   `${num(28,42)}%`,
      description: `The addressable market for ${sector.toLowerCase()} solutions is at an early inflection point. ${s}'s SAM is estimated at $${tamValues[2]}B in 2026E growing to $${tamValues[6]}B by 2030. At a ${num(10,20)}% market share capture rate, revenue potential exceeds current consensus by 2–3×.`,
    },

    keyPlayers: [
      { name: 'CEO & Co-Founder',        role: 'Chief Executive Officer', note: `Visionary founder, owns ${num(8,25)}% of shares — strong alignment. Previously founded and exited ${num(1,3)} technology companies. Rated top 10% of public company CEOs.` },
      { name: 'CTO / Chief Architect',   role: 'Chief Technology Officer', note: `PhD Computer Science / ML. Previously led AI research at a major tech company. Architect of ${s}'s proprietary platform. Key person risk — departure would be a significant negative signal.` },
      { name: 'Chief Financial Officer', role: 'CFO', note: `Former ${pick(['Goldman Sachs','Morgan Stanley','JPMorgan','Evercore'])} banker. Brought in ${num(1,3)} years ago to lead capital markets and drive operational discipline. Guiding the company toward first profitability by FY${num(26,28)}.` },
      { name: 'Lead Independent Director', role: 'Board Chair', note: `Managing Partner at a top-tier venture fund. Led Series A–C totaling $${num(150,500)}M. Deep network in the ${sector.toLowerCase()} ecosystem and board-level experience at ${num(3,7)} public tech companies.` },
    ],

    financials: {
      revenue:       revenues,
      grossMargin:   `${gm}%`,
      ebitdaMargin:  `${ebitdaMargin}%`,
      revenueCAGR:   `${revenueCAGR}%`,
      netCash:       `$${num(100,800)}M`,
    },

    valuation: {
      method:          `DCF (10-yr, ${num(8,12)}% WACC, ${num(3,5)}% terminal growth) + EV/Revenue comps`,
      dcfTarget:       Math.round(basePrice * (105 + num(0,10)) / 100),
      compsTarget:     Math.round(basePrice * (90  + num(0,10)) / 100),
      baseTarget:      basePrice,
      analystConsensus: analystTarget,
      strongBuyCount:  strongBuys,
      buyCount:        buys,
      holdCount:       holds,
      sellCount:       sells,
      ptRangeLow:      Math.round(analystTarget * 0.7),
      ptRangeHigh:     Math.round(analystTarget * 1.4),
      description:     `At $${curPrice}, ${s} trades at a ${num(8,18)}× EV/Revenue on FY26E estimates — a meaningful discount to peers at ${num(20,40)}×. As ${s} demonstrates durable growth and operating leverage over the next 4–6 quarters, the multiple should re-rate toward peer levels.`,
    },

    scenarios: {
      bull: {
        price: bullPrice,
        return: `+${bullReturn}%`,
        prob: bullProb,
        assumptions: [
          `Revenue grows at ${num(90,130)}%+ CAGR through 2027 — TAM expansion + accelerating market share capture`,
          `Gross margins expand to ${num(78,88)}% as platform scales and mix shifts to high-margin software`,
          `Multiple re-rates to ${num(28,50)}× EV/Revenue as growth durability and margin profile are established`,
          `M&A or strategic partnership accelerates international expansion into EU and APAC markets`,
        ],
      },
      base: {
        price: basePrice,
        return: `+${baseReturn}%`,
        prob: baseProb,
        assumptions: [
          `Revenue compounds at ${num(55,80)}% CAGR — consistent execution on core product roadmap`,
          `Gross margins improve to ${num(65,78)}% as product mix matures and infrastructure costs normalize`,
          `Multiple holds at ${num(15,25)}× EV/Revenue — growth premium sustained through disciplined capital allocation`,
          `Steady market share gains in core vertical, early traction in 1–2 adjacent categories`,
        ],
      },
      bear: {
        price: bearPrice,
        return: bearReturn >= 0 ? `+${bearReturn}%` : `${bearReturn}%`,
        prob: bearProb,
        assumptions: [
          `Revenue growth decelerates to ${num(15,40)}% — competitive pressure or macro enterprise spending freeze`,
          `Gross margin compression to ${num(45,60)}% as pricing power erodes under competitive pressure`,
          `Multiple de-rates to ${num(5,12)}× EV/Revenue as market re-categorizes ${s} from growth to value`,
          `Big Tech bundling or platform shift takes share — customer churn accelerates beyond cohort models`,
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
    const { data, error } = await supabase
      .from('theses')
      .select('data, generated_at')
      .eq('symbol', symbol)
      .single()

    if (!error && data) {
      return res.json({ ...data.data, cached: true, generatedAt: data.generated_at })
    }
  }

  return res.status(404).json({ error: `No thesis found for ${symbol}. POST /api/generate-thesis to create one.` })
})

// POST /api/generate-thesis  { symbol }
app.post('/api/generate-thesis', async (req, res) => {
  const { symbol } = req.body
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' })

  const sym    = symbol.trim().toUpperCase()
  const thesis = generateMockThesis(sym)

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
    version: '3.0.0',
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

app.listen(PORT, () => console.log(`Stock10x API → http://localhost:${PORT}`))
module.exports = app
