// MiniMax M2.5 Proxy via Puter.js
// Provides OpenAI-compatible API that routes to free Puter.js

const express = require('express');
const minimaxTracker = require('./minimax-tracker');

const router = express.Router();

// OpenAI-compatible chat completions endpoint
router.post('/v1/chat/completions', express.json(), async (req, res) => {
  const { messages, model, temperature, max_tokens } = req.body;
  
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }
  
  const startTime = Date.now();
  
  try {
    // Convert to Puter.js format (simple prompt)
    const lastMessage = messages[messages.length - 1];
    const prompt = lastMessage.content;
    
    // Call Puter.js API
    const response = await fetch('https://api.puter.com/drivers/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interface: 'puter-chat-completion',
        driver: 'minimax',
        method: 'complete',
        args: {
          messages: messages.map(m => ({
            role: m.role,
            content: m.content
          })),
          model: 'minimax-m2.5'
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Puter.js API error:', response.status, errorText);
      return res.status(502).json({ 
        error: 'MiniMax API error',
        details: errorText
      });
    }
    
    const data = await response.json();
    const responseTime = (Date.now() - startTime) / 1000;
    
    // Extract response text
    const responseText = data.message?.content || data.text || JSON.stringify(data);
    
    // Estimate tokens (rough: ~4 chars per token)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(responseText.length / 4);
    
    // Log usage
    minimaxTracker.logApiCall(inputTokens, outputTokens, responseTime, 'MiniMax-M2.5 (Puter.js)');
    
    // Return OpenAI-compatible response
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'minimax/MiniMax-M2.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: responseText
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    });
    
  } catch (error) {
    console.error('MiniMax proxy error:', error);
    res.status(500).json({ 
      error: 'Proxy error',
      message: error.message 
    });
  }
});

module.exports = router;
