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

app.get('/', (req, res) => {
  res.json({
    service: 'Stock10x API',
    version: '2.0.0',
    supabase: !!supabase,
    endpoints: [
      'GET  /api/stock?symbol=NVDA',
      'GET  /api/stock/NVDA',
      'GET  /api/stocks',
      'POST /api/stocks  { symbol, name, current_price, price_target_2030, analyst_price_target, action }',
    ],
  })
})

app.listen(PORT, () => console.log(`Stock10x API → http://localhost:${PORT}`))
module.exports = app
