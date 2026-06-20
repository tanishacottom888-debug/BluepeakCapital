// bot_engine.js - Trading Bot Engine

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const supabaseUrl = 'https://txcbfzcomfyavcgqcevq.supabase.co'
const supabaseAnonKey = 'sb_publishable_6-gQnlgqnM20wQ9iWx5lsw_ZD7Uz5bH'
const supabase = createClient(supabaseUrl, supabaseAnonKey)

class TradingBot {
    constructor(config) {
        this.id = config.id
        this.userId = config.user_id
        this.pair = config.pair
        this.strategy = config.strategy
        this.settings = config.settings
        this.status = config.status || 'stopped'
        this.isRunning = false
        this.intervalId = null
        this.priceHistory = []
        this.positions = []
        this.lastMACD = null
        
        // Logging
        this.logs = []
    }

    async start() {
        if (this.isRunning) return
        this.isRunning = true
        this.status = 'running'
        
        await this.updateStatus('running')
        await this.log('info', '🤖 Bot started successfully')
        
        this.runLoop()
        console.log(`🤖 Bot ${this.id} started!`)
        
        // Update UI
        this.updateUI()
    }

    async stop() {
        this.isRunning = false
        this.status = 'stopped'
        
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
        
        await this.updateStatus('stopped')
        await this.log('info', '⏹ Bot stopped')
        console.log(`🤖 Bot ${this.id} stopped!`)
        
        this.updateUI()
    }

    runLoop() {
        // Run every 30 seconds
        this.intervalId = setInterval(async () => {
            if (!this.isRunning) return
            
            try {
                await this.executeStrategy()
            } catch (error) {
                console.error('Bot error:', error)
                await this.log('error', `❌ Error: ${error.message}`)
            }
        }, 30000) // 30 seconds
    }

    async executeStrategy() {
        // Get current price
        const price = await this.getCurrentPrice()
        const balances = await this.getUserBalances()
        const pairAsset = this.pair.split('/')[0]

        console.log(`📊 ${this.strategy} strategy executing at price $${price}`)

        switch(this.strategy) {
            case 'grid':
                await this.gridStrategy(price, balances, pairAsset)
                break
            case 'dca':
                await this.dcaStrategy(price, balances, pairAsset)
                break
            case 'rsi':
                await this.rsiStrategy(price, balances, pairAsset)
                break
            case 'macd':
                await this.macdStrategy(price, balances, pairAsset)
                break
            default:
                console.log('Unknown strategy:', this.strategy)
        }
    }

    // ============================================
    // STRATEGY IMPLEMENTATIONS
    // ============================================

    // 1. GRID STRATEGY
    async gridStrategy(price, balances, pairAsset) {
        const { gridLevels, gridSpacing, investmentPerLevel } = this.settings
        
        // Calculate grid levels
        const buyLevels = []
        const sellLevels = []
        
        for (let i = 0; i < gridLevels; i++) {
            const buyPrice = price * (1 - (i + 1) * gridSpacing / 100)
            const sellPrice = price * (1 + (i + 1) * gridSpacing / 100)
            buyLevels.push(buyPrice)
            sellLevels.push(sellPrice)
        }

        // Check buy levels
        for (const buyPrice of buyLevels) {
            if (price <= buyPrice) {
                const amount = investmentPerLevel / price
                const total = amount * price
                
                // Check if we have enough USD
                if (total <= balances.USD) {
                    await this.executeTrade('buy', price, amount, pairAsset)
                    await this.log('success', `📈 Grid BUY: ${amount} ${pairAsset} at $${price}`)
                    break
                } else {
                    await this.log('warning', `⚠️ Insufficient USD for grid buy: $${total.toFixed(2)} needed`)
                }
            }
        }

        // Check sell positions
        for (const position of this.positions) {
            if (price >= position.takeProfit) {
                await this.executeTrade('sell', price, position.amount, pairAsset)
                await this.log('success', `📉 Grid SELL: ${position.amount} ${pairAsset} at $${price}`)
                this.positions = this.positions.filter(p => p !== position)
                break
            }
        }
    }

    // 2. DCA STRATEGY
    async dcaStrategy(price, balances, pairAsset) {
        const { interval, amountPerTrade, maxTrades } = this.settings
        
        const lastTrade = await this.getLastTrade()
        const now = Date.now()
        
        let shouldTrade = false
        
        if (!lastTrade) {
            shouldTrade = true
        } else {
            const timeSinceLastTrade = now - new Date(lastTrade.created_at).getTime()
            if (timeSinceLastTrade >= interval * 60000) {
                shouldTrade = true
            }
        }

        if (shouldTrade) {
            const tradeCount = await this.getTradeCount()
            if (tradeCount < maxTrades) {
                const amount = amountPerTrade / price
                const total = amount * price
                
                if (total <= balances.USD) {
                    await this.executeTrade('buy', price, amount, pairAsset)
                    await this.log('success', `💰 DCA BUY: ${amount} ${pairAsset} at $${price}`)
                } else {
                    await this.log('warning', `⚠️ Insufficient USD for DCA: $${total.toFixed(2)} needed`)
                }
            } else {
                await this.log('info', `📊 Max trades (${maxTrades}) reached for DCA strategy`)
            }
        }
    }

    // 3. RSI STRATEGY
    async rsiStrategy(price, balances, pairAsset) {
        const { rsiPeriod, oversoldLevel, overboughtLevel, amountPerTrade } = this.settings
        
        // Add price to history
        await this.updatePriceHistory(price)
        
        // Calculate RSI
        const rsi = this.calculateRSI(this.priceHistory, rsiPeriod)
        
        if (!rsi) {
            await this.log('info', `⏳ Building RSI history... (${this.priceHistory.length}/${rsiPeriod + 1})`)
            return
        }

        console.log(`📊 Current RSI: ${rsi.toFixed(2)}`)

        if (rsi < oversoldLevel) {
            // Oversold - BUY signal
            const amount = amountPerTrade / price
            const total = amount * price
            
            if (total <= balances.USD) {
                await this.executeTrade('buy', price, amount, pairAsset)
                await this.log('success', `📈 RSI BUY signal! RSI=${rsi.toFixed(2)}, price=$${price}`)
            }
        } else if (rsi > overboughtLevel) {
            // Overbought - SELL signal
            const balance = balances[pairAsset] || 0
            if (balance > 0) {
                const sellAmount = balance * 0.5 // Sell 50%
                await this.executeTrade('sell', price, sellAmount, pairAsset)
                await this.log('success', `📉 RSI SELL signal! RSI=${rsi.toFixed(2)}, price=$${price}`)
            }
        }
    }

    // 4. MACD STRATEGY
    async macdStrategy(price, balances, pairAsset) {
        const { fastPeriod, slowPeriod, signalPeriod, amountPerTrade } = this.settings
        
        await this.updatePriceHistory(price)
        
        const macd = this.calculateMACD(this.priceHistory, fastPeriod, slowPeriod, signalPeriod)
        
        if (!macd) {
            await this.log('info', `⏳ Building MACD history... (${this.priceHistory.length}/${slowPeriod + signalPeriod})`)
            return
        }

        console.log(`📊 MACD: ${macd.macdLine.toFixed(2)}, Signal: ${macd.signalLine.toFixed(2)}`)

        // Bullish crossover: MACD crosses above Signal
        if (macd.macdLine > macd.signalLine && 
            this.lastMACD && this.lastMACD.macdLine <= this.lastMACD.signalLine) {
            
            const amount = amountPerTrade / price
            const total = amount * price
            
            if (total <= balances.USD) {
                await this.executeTrade('buy', price, amount, pairAsset)
                await this.log('success', `📈 MACD BUY crossover! MACD=${macd.macdLine.toFixed(2)}`)
            }
        }
        // Bearish crossover: MACD crosses below Signal
        else if (macd.macdLine < macd.signalLine && 
                 this.lastMACD && this.lastMACD.macdLine >= this.lastMACD.signalLine) {
            
            const balance = balances[pairAsset] || 0
            if (balance > 0) {
                const sellAmount = balance * 0.5
                await this.executeTrade('sell', price, sellAmount, pairAsset)
                await this.log('success', `📉 MACD SELL crossover! MACD=${macd.macdLine.toFixed(2)}`)
            }
        }
        
        this.lastMACD = macd
    }

    // ============================================
    // TRADE EXECUTION
    // ============================================

    async executeTrade(type, price, amount, pairAsset) {
        const total = amount * price
        const fee = total * 0.001
        
        // Get current balances
        const balances = await this.getUserBalances()
        
        // Verify balances
        if (type === 'buy' && total > balances.USD) {
            await this.log('error', `❌ Insufficient USD: $${balances.USD.toFixed(2)} available, $${total.toFixed(2)} needed`)
            return false
        }
        
        if (type === 'sell' && amount > (balances[pairAsset] || 0)) {
            await this.log('error', `❌ Insufficient ${pairAsset}: ${(balances[pairAsset] || 0).toFixed(4)} available`)
            return false
        }

        // Update balances in Supabase
        if (type === 'buy') {
            // Deduct USD
            await this.updateBalance('USD', total, 'subtract')
            // Add crypto
            await this.updateBalance(pairAsset, amount, 'add')
        } else {
            // Deduct crypto
            await this.updateBalance(pairAsset, amount, 'subtract')
            // Add USD
            await this.updateBalance('USD', total, 'add')
        }

        // Save trade to history
        await this.saveBotTrade(type, price, amount, total, fee)
        
        // Update bot stats
        await this.updateBotStats(type, total)
        
        // Update positions for grid strategy
        if (this.strategy === 'grid' && type === 'buy') {
            const sellPrice = price * (1 + this.settings.gridSpacing / 100)
            this.positions.push({
                entryPrice: price,
                amount: amount,
                takeProfit: sellPrice
            })
        }

        // Refresh user balances in UI
        if (window.loadUserBalances) {
            await window.loadUserBalances()
        }

        // Send notification
        const pairDisplay = this.pair.replace('/', ' / ')
        const tradeMessage = `${type.toUpperCase()} ${amount.toFixed(4)} ${pairAsset} at $${price.toFixed(2)}`
        
        if (typeof showToast === 'function') {
            showToast(`✅ ${tradeMessage}`)
        }

        console.log(`✅ ${type.toUpperCase()} executed: ${tradeMessage}`)
        
        return true
    }

    // ============================================
    // DATABASE OPERATIONS
    // ============================================

    async getCurrentPrice() {
        const symbol = this.pair.replace('/', '')
        try {
            const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
            const data = await response.json()
            return parseFloat(data.price)
        } catch (error) {
            console.error('Error fetching price:', error)
            return 43250 // Fallback price
        }
    }

    async getUserBalances() {
        const { data, error } = await supabase
            .from('user_balances')
            .select('*')
            .eq('user_id', this.userId)
        
        if (error) {
            console.error('Error fetching balances:', error)
            return { USD: 0 }
        }
        
        const balances = { USD: 0 }
        data.forEach(b => {
            balances[b.asset] = parseFloat(b.balance) || 0
        })
        return balances
    }

    async updateBalance(asset, amount, operation) {
        const { data, error } = await supabase
            .from('user_balances')
            .select('balance')
            .eq('user_id', this.userId)
            .eq('asset', asset)
            .single()
        
        if (error && error.code !== 'PGRST116') {
            console.error('Error fetching balance:', error)
            return false
        }
        
        const currentBalance = data?.balance || 0
        const newBalance = operation === 'add' ? 
            currentBalance + amount : 
            currentBalance - amount
        
        const { error: updateError } = await supabase
            .from('user_balances')
            .upsert({
                user_id: this.userId,
                asset: asset,
                balance: newBalance,
                updated_at: new Date().toISOString()
            })
        
        if (updateError) {
            console.error('Error updating balance:', updateError)
            return false
        }
        
        return true
    }

    async saveBotTrade(type, price, amount, total, fee) {
        const { data, error } = await supabase
            .from('bot_trades')
            .insert({
                bot_id: this.id,
                user_id: this.userId,
                pair: this.pair,
                type: type,
                price: price,
                amount: amount,
                total: total,
                fee: fee,
                status: 'completed',
                created_at: new Date().toISOString()
            })
            .select()
            .single()
        
        if (error) {
            console.error('Error saving trade:', error)
            return null
        }
        
        return data
    }

    async updateBotStats(type, total) {
        // Get current stats
        const { data: current } = await supabase
            .from('bot_configs')
            .select('total_trades, total_invested, total_profit')
            .eq('id', this.id)
            .single()
        
        if (!current) return
        
        const newTrades = (current.total_trades || 0) + 1
        let newInvested = current.total_invested || 0
        let newProfit = current.total_profit || 0
        
        if (type === 'buy') {
            newInvested += total
        } else {
            // For sell, calculate profit (simplified)
            const avgPrice = newInvested / (current.total_trades || 1)
            newProfit += total - (total * 0.001) // minus fee
        }
        
        const { error } = await supabase
            .from('bot_configs')
            .update({
                total_trades: newTrades,
                total_invested: newInvested,
                total_profit: newProfit,
                updated_at: new Date().toISOString()
            })
            .eq('id', this.id)
        
        if (error) {
            console.error('Error updating bot stats:', error)
        }
    }

    async updateStatus(status) {
        const { error } = await supabase
            .from('bot_configs')
            .update({
                status: status,
                updated_at: new Date().toISOString(),
                last_run_at: status === 'running' ? new Date().toISOString() : null
            })
            .eq('id', this.id)
        
        if (error) {
            console.error('Error updating status:', error)
        }
    }

    async log(level, message) {
        const logEntry = {
            bot_id: this.id,
            level: level,
            message: message,
            created_at: new Date().toISOString()
        }
        
        this.logs.push(logEntry)
        
        const { error } = await supabase
            .from('bot_logs')
            .insert(logEntry)
        
        if (error) {
            console.error('Error logging:', error)
        }
    }

    async getLastTrade() {
        const { data, error } = await supabase
            .from('bot_trades')
            .select('*')
            .eq('bot_id', this.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single()
        
        if (error && error.code !== 'PGRST116') {
            console.error('Error getting last trade:', error)
        }
        
        return data
    }

    async getTradeCount() {
        const { count, error } = await supabase
            .from('bot_trades')
            .select('*', { count: 'exact', head: true })
            .eq('bot_id', this.id)
        
        if (error) {
            console.error('Error getting trade count:', error)
            return 0
        }
        
        return count || 0
    }

    async updatePriceHistory(price) {
        this.priceHistory.push(price)
        if (this.priceHistory.length > 100) {
            this.priceHistory.shift()
        }
    }

    // ============================================
    // TECHNICAL INDICATORS
    // ============================================

    calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return null
        
        let gains = 0, losses = 0
        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1]
            if (diff >= 0) gains += diff
            else losses += Math.abs(diff)
        }
        
        const avgGain = gains / period
        const avgLoss = losses / period
        
        if (avgLoss === 0) return 100
        const rs = avgGain / avgLoss
        return 100 - (100 / (1 + rs))
    }

    calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
        if (prices.length < slow + signal) return null
        
        const emaFast = this.calculateEMA(prices, fast)
        const emaSlow = this.calculateEMA(prices, slow)
        const macdLine = emaFast - emaSlow
        
        // Calculate signal line
        const macdValues = []
        for (let i = slow; i < prices.length; i++) {
            const fastEma = this.calculateEMA(prices.slice(0, i + 1), fast)
            const slowEma = this.calculateEMA(prices.slice(0, i + 1), slow)
            macdValues.push(fastEma - slowEma)
        }
        
        const signalLine = this.calculateEMA(macdValues, signal)
        const histogram = macdLine - signalLine
        
        return { macdLine, signalLine, histogram }
    }

    calculateEMA(values, period) {
        if (values.length === 0) return 0
        const k = 2 / (period + 1)
        let ema = values[0]
        for (let i = 1; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k)
        }
        return ema
    }

    // ============================================
    // UI UPDATE
    // ============================================

    updateUI() {
        // This will be called from the bot page to update UI
        if (window.updateBotUI) {
            window.updateBotUI(this.id, this.status)
        }
    }
}

// Export for use in browser
export { TradingBot, supabase }
