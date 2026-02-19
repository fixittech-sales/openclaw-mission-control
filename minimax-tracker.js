// MiniMax M2.5 Usage Tracker
// Stores usage data and provides API endpoints

const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, 'minimax-usage.json');
const RATE_LIMITS = {
  rpm: 500,  // requests per minute
  tpm: 20000000  // tokens per minute (20M)
};

// Initialize usage file if it doesn't exist
function initUsageFile() {
  if (!fs.existsSync(USAGE_FILE)) {
    const initialData = {
      dailyStats: {},
      recentCalls: []
    };
    fs.writeFileSync(USAGE_FILE, JSON.stringify(initialData, null, 2));
  }
}

// Get usage data
function getUsageData() {
  initUsageFile();
  const data = fs.readFileSync(USAGE_FILE, 'utf8');
  return JSON.parse(data);
}

// Save usage data
function saveUsageData(data) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
}

// Log an API call
function logApiCall(inputTokens, outputTokens, responseTime, model = 'MiniMax-M2.5') {
  const data = getUsageData();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  // Initialize today's stats if needed
  if (!data.dailyStats[today]) {
    data.dailyStats[today] = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      avgResponseTime: 0,
      calls: []
    };
  }
  
  const todayStats = data.dailyStats[today];
  
  // Update stats
  todayStats.requests++;
  todayStats.inputTokens += inputTokens;
  todayStats.outputTokens += outputTokens;
  todayStats.totalTokens += (inputTokens + outputTokens);
  
  // Update average response time
  const totalTime = todayStats.avgResponseTime * (todayStats.requests - 1) + responseTime;
  todayStats.avgResponseTime = totalTime / todayStats.requests;
  
  // Add to recent calls (keep last 100)
  const callData = {
    timestamp: now.toISOString(),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    responseTime,
    model
  };
  
  data.recentCalls.unshift(callData);
  if (data.recentCalls.length > 100) {
    data.recentCalls = data.recentCalls.slice(0, 100);
  }
  
  saveUsageData(data);
  return callData;
}

// Get current usage stats
function getCurrentStats() {
  const data = getUsageData();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  const todayStats = data.dailyStats[today] || {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgResponseTime: 0
  };
  
  // Calculate current minute usage (for rate limits)
  const oneMinuteAgo = new Date(now - 60000);
  const recentCalls = data.recentCalls.filter(call => 
    new Date(call.timestamp) > oneMinuteAgo
  );
  
  const currentMinuteRequests = recentCalls.length;
  const currentMinuteTokens = recentCalls.reduce((sum, call) => sum + call.totalTokens, 0);
  
  // Calculate percentages
  const rpmPercent = (currentMinuteRequests / RATE_LIMITS.rpm) * 100;
  const tpmPercent = (currentMinuteTokens / RATE_LIMITS.tpm) * 100;
  
  // Estimate cost (MiniMax M2.5: $0.15 per M input tokens, $1.20 per M output tokens)
  const costToday = (
    (todayStats.inputTokens / 1000000) * 0.15 +
    (todayStats.outputTokens / 1000000) * 1.20
  );
  
  return {
    today: todayStats,
    currentMinute: {
      requests: currentMinuteRequests,
      tokens: currentMinuteTokens,
      rpmPercent: Math.round(rpmPercent * 10) / 10,
      tpmPercent: Math.round(tpmPercent * 10) / 10
    },
    rateLimits: RATE_LIMITS,
    costToday: Math.round(costToday * 100) / 100,
    recentCalls: data.recentCalls.slice(0, 10)
  };
}

// Get historical data (last 7 days)
function getHistoricalStats() {
  const data = getUsageData();
  const last7Days = [];
  const today = new Date();
  
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    
    const stats = data.dailyStats[dateStr] || {
      requests: 0,
      totalTokens: 0
    };
    
    last7Days.push({
      date: dateStr,
      requests: stats.requests || 0,
      tokens: stats.totalTokens || 0
    });
  }
  
  return last7Days;
}

module.exports = {
  initUsageFile,
  logApiCall,
  getCurrentStats,
  getHistoricalStats
};
