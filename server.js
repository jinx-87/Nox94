const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables (set these in Render dashboard)
const API_BASE = process.env.API_BASE;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000;

// Store active brewing sessions
let brewingSessions = {};

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Generate session ID
function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

// Helper function to make API calls directly (bypassing the proxy for internal calls)
async function makeDirectApiCall(endpoint, method = 'GET', headers = {}, data = null) {
    const url = `${API_BASE}${endpoint}`;
    
    const proxyHeaders = {
        ...headers,
        'User-Agent': 'Brewing-Master/1.0',
    };

    delete proxyHeaders['host'];
    delete proxyHeaders['origin'];
    delete proxyHeaders['referer'];

    try {
        const response = await axios({
            url: url,
            method: method,
            headers: proxyHeaders,
            data: data,
            timeout: REQUEST_TIMEOUT,
            validateStatus: null
        });
        
        return response;
    } catch (error) {
        console.error(`Direct API call error:`, error.message);
        throw error;
    }
}

// Proxy endpoint - for frontend use
app.post('/proxy', async (req, res) => {
    const { endpoint, method, headers, data } = req.body;
    
    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
    }

    try {
        const response = await makeDirectApiCall(endpoint, method, headers, data);
        console.log(`[${new Date().toISOString()}] ${method} ${endpoint} -> ${response.status}`);
        res.status(response.status).json(response.data);
    } catch (error) {
        console.error(`Proxy error:`, error.message);
        
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Request timeout' });
        }
        
        res.status(500).json({ error: 'Proxy error', message: error.message });
    }
});

// Start brewing session
app.post('/api/brewing/start', async (req, res) => {
    const { 
        authTokens, 
        senderIDs, 
        maxBrews, 
        operationDelay,
        brewingPlanId,
        silvercoins,
        minMintNumber,
        requirementsConfig
    } = req.body;
    
    if (!authTokens || !senderIDs || authTokens.length !== senderIDs.length) {
        return res.status(400).json({ error: 'Invalid account data' });
    }
    
    const sessionId = generateSessionId();
    
    brewingSessions[sessionId] = {
        id: sessionId,
        status: 'pending',
        progress: 0,
        authTokens,
        senderIDs,
        maxBrews,
        operationDelay,
        brewingPlanId,
        silvercoins,
        minMintNumber,
        requirementsConfig,
        accountsProcessed: 0,
        totalBrews: 0,
        completedBrews: 0,
        successfulBrews: 0,
        totalCardsCollected: 0,
        logs: [],
        brewingResults: [],
        stopRequested: false,
        pauseRequested: false,
        proceedAfterScan: false,
        scanComplete: false,
        scanResults: null,
        createdAt: new Date().toISOString()
    };
    
    // Start processing in background
    processBrewingSession(sessionId).catch(error => {
        addLogToSession(sessionId, `Fatal error: ${error.message}`, 'error');
        brewingSessions[sessionId].status = 'error';
    });
    
    res.json({ 
        success: true, 
        sessionId,
        message: 'Brewing session started'
    });
});

// Get session status
app.get('/api/brewing/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = brewingSessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
        id: session.id,
        status: session.status,
        progress: session.progress,
        accountsProcessed: session.accountsProcessed,
        totalBrews: session.totalBrews,
        completedBrews: session.completedBrews,
        successfulBrews: session.successfulBrews,
        totalCardsCollected: session.totalCardsCollected,
        scanComplete: session.scanComplete,
        scanResults: session.scanResults,
        logs: session.logs.slice(-50),
        brewingResults: session.brewingResults,
        stopRequested: session.stopRequested,
        pauseRequested: session.pauseRequested
    });
});

// Get full logs
app.get('/api/brewing/logs/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = brewingSessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
        logs: session.logs
    });
});

// Pause session
app.post('/api/brewing/pause/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = brewingSessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    session.pauseRequested = true;
    addLogToSession(sessionId, 'Pause requested by user', 'warning');
    
    res.json({ success: true, message: 'Pause requested' });
});

// Resume session
app.post('/api/brewing/resume/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = brewingSessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    session.pauseRequested = false;
    addLogToSession(sessionId, 'Resumed by user', 'success');
    
    res.json({ success: true, message: 'Resumed' });
});

// Stop session
app.post('/api/brewing/stop/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = brewingSessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    session.stopRequested = true;
    session.pauseRequested = false;
    addLogToSession(sessionId, 'Stop requested by user', 'warning');
    
    res.json({ success: true, message: 'Stop requested' });
});

// Proceed after scan
app.post('/api/brewing/proceed/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = brewingSessions[sessionId];
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    if (!session.scanComplete) {
        return res.status(400).json({ error: 'Scan not complete yet' });
    }
    
    session.proceedAfterScan = true;
    addLogToSession(sessionId, 'Proceeding to brewing after user confirmation', 'success');
    
    res.json({ success: true, message: 'Proceeding to brewing' });
});

// Clean up old sessions (run every hour)
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of Object.entries(brewingSessions)) {
        const sessionTime = new Date(session.createdAt).getTime();
        if (now - sessionTime > 24 * 60 * 60 * 1000) {
            delete brewingSessions[sessionId];
        }
    }
}, 60 * 60 * 1000);

// Helper to add log to session
function addLogToSession(sessionId, message, type = 'info') {
    const session = brewingSessions[sessionId];
    if (session) {
        session.logs.push({
            timestamp: new Date().toISOString(),
            message,
            type
        });
    }
}

// Process brewing session
async function processBrewingSession(sessionId) {
    const session = brewingSessions[sessionId];
    if (!session) return;
    
    session.status = 'running';
    addLogToSession(sessionId, `Starting brewing session with ${session.authTokens.length} account(s)`);
    
    try {
        for (let accountIndex = 0; accountIndex < session.authTokens.length; accountIndex++) {
            if (session.stopRequested) {
                addLogToSession(sessionId, 'Session stopped by user', 'warning');
                break;
            }
            
            while (session.pauseRequested && !session.stopRequested) {
                await delay(1000);
            }
            
            if (session.stopRequested) break;
            
            const authToken = session.authTokens[accountIndex];
            const senderID = session.senderIDs[accountIndex];
            
            await processAccount(sessionId, authToken, senderID, accountIndex);
            
            session.accountsProcessed = accountIndex + 1;
            session.progress = (session.accountsProcessed / session.authTokens.length) * 100;
            
            if (accountIndex < session.authTokens.length - 1 && !session.stopRequested) {
                await delay(session.operationDelay);
            }
        }
        
        if (!session.stopRequested) {
            session.status = 'completed';
            addLogToSession(sessionId, 'All accounts processed successfully!', 'success');
            generateFinalSummary(sessionId);
        } else {
            session.status = 'stopped';
        }
    } catch (error) {
        session.status = 'error';
        addLogToSession(sessionId, `Session error: ${error.message}`, 'error');
    }
}

// Process a single account
async function processAccount(sessionId, authToken, senderID, accountIndex) {
    const session = brewingSessions[sessionId];
    const accountNumber = accountIndex + 1;
    
    addLogToSession(sessionId, `=== Processing Account ${accountNumber} (Sender: ${senderID}) ===`, 'account');
    
    try {
        addLogToSession(sessionId, `Checking funds for account ${accountNumber}...`);
        
        let silverBalance = 0;
        try {
            silverBalance = await checkUserFunds(authToken);
            addLogToSession(sessionId, `Silver balance: ${silverBalance.toLocaleString()}`, 'success');
        } catch (fundsError) {
            addLogToSession(sessionId, `Failed to check funds: ${fundsError.message}`, 'error');
            return;
        }
        
        addLogToSession(sessionId, `Scanning collections for available cards...`);
        
        const cardsByRequirement = {};
        const cardsWithDetails = {};
        
        for (const [requirementId, config] of Object.entries(session.requirementsConfig)) {
            if (session.stopRequested) return;
            
            while (session.pauseRequested && !session.stopRequested) {
                await delay(1000);
            }
            
            addLogToSession(sessionId, `Collecting cards for requirement ${requirementId} (${config.cardsPerBrew} cards per brew)...`);
            
            const cards = [];
            for (const collectionId of config.collectionIds) {
                if (session.stopRequested) return;
                
                const collectionCards = await getCollectionCardsWithDetails(authToken, senderID, collectionId, session.minMintNumber);
                
                const availableCards = collectionCards.filter(card => 
                    card.status === 'available' && 
                    !card.isMarketList && 
                    card.ethStatus !== 'imx_locked' &&
                    card.bundleId === null
                );
                
                addLogToSession(sessionId, `  - Collection ${collectionId}: ${collectionCards.length} total, ${availableCards.length} available (min mint filter: ${session.minMintNumber})`);
                
                availableCards.forEach(card => {
                    cardsWithDetails[card.id] = card;
                });
                
                cards.push(...availableCards.map(card => card.id));
                
                await delay(1000);
            }
            
            cardsByRequirement[requirementId] = cards;
            session.totalCardsCollected += cards.length;
        }
        
        addLogToSession(sessionId, `Total available cards collected: ${session.totalCardsCollected}`, 'success');
        
        const cardBasedBatches = calculateBrewableBatches(cardsByRequirement, session.requirementsConfig, session.maxBrews);
        
        if (cardBasedBatches === 0) {
            addLogToSession(sessionId, `Not enough cards for any brewing operations`, 'error');
            return;
        }
        
        const silverPerBrew = session.silvercoins;
        const fundBasedBatches = Math.floor(silverBalance / silverPerBrew);
        
        const lowestMintUsed = await findLowestMintToBeUsed(cardsByRequirement, cardsWithDetails, session.requirementsConfig, cardBasedBatches);
        
        session.scanResults = {
            accountNumber,
            senderID,
            cardBasedBatches,
            fundBasedBatches,
            silverBalance,
            silverPerBrew,
            lowestMintUsed,
            cardsByRequirement,
            cardsWithDetails,
            totalCards: session.totalCardsCollected
        };
        
        addLogToSession(sessionId, `=== SCAN COMPLETE ===`, 'highlight');
        addLogToSession(sessionId, `Based on cards: Can perform ${cardBasedBatches} brewing operation(s)`);
        addLogToSession(sessionId, `Based on funds: Can afford ${fundBasedBatches} brewing operation(s)`);
        addLogToSession(sessionId, `Lowest mint that will be used: ${lowestMintUsed}`, 'warning');
        addLogToSession(sessionId, `Please review and click "Proceed to Brew" to continue`, 'highlight');
        
        session.scanComplete = true;
        
        while (!session.proceedAfterScan && !session.stopRequested) {
            await delay(1000);
        }
        
        if (session.stopRequested) return;
        
        session.proceedAfterScan = false;
        session.scanComplete = false;
        
        let actualBatches = Math.min(cardBasedBatches, fundBasedBatches, session.maxBrews);
        
        if (actualBatches === 0) {
            if (fundBasedBatches === 0) {
                addLogToSession(sessionId, `Insufficient funds for any brewing operations`, 'error');
            } else {
                addLogToSession(sessionId, `No brews possible due to card limitations`, 'error');
            }
            return;
        }
        
        addLogToSession(sessionId, `Will perform ${actualBatches} brewing operation(s)`, 'success');
        
        const initialSilver = silverBalance;
        const usedCardIds = new Set();
        const sortedCardsByRequirement = sortCardsByMintDesc(cardsByRequirement, cardsWithDetails);
        
        for (let batchNum = 1; batchNum <= actualBatches; batchNum++) {
            if (session.stopRequested) break;
            
            while (session.pauseRequested && !session.stopRequested) {
                await delay(1000);
            }
            
            addLogToSession(sessionId, `Processing brew ${batchNum}/${actualBatches}...`, 'brew-header');
            
            try {
                const currentSilver = await checkUserFunds(authToken);
                if (currentSilver < silverPerBrew) {
                    addLogToSession(sessionId, `Insufficient funds for next brew (balance: ${currentSilver.toLocaleString()})`, 'error');
                    break;
                }
            } catch (fundsError) {
                addLogToSession(sessionId, `Could not verify funds before brew ${batchNum}`, 'warning');
            }
            
            const brewResult = await processBrew(
                sessionId,
                authToken,
                senderID,
                sortedCardsByRequirement,
                cardsWithDetails,
                usedCardIds,
                batchNum
            );
            
            if (brewResult && brewResult.success) {
                session.successfulBrews++;
                if (brewResult.cardsReceived && brewResult.cardsReceived.length > 0) {
                    session.brewingResults.push(...brewResult.cardsReceived);
                }
            }
            
            session.completedBrews++;
            session.totalBrews++;
            
            session.progress = ((accountIndex * 100) + (batchNum / actualBatches * 100)) / session.authTokens.length;
            
            if (batchNum < actualBatches && !session.stopRequested) {
                await delay(session.operationDelay);
            }
        }
        
        try {
            const finalSilver = await checkUserFunds(authToken);
            const silverSpent = initialSilver - finalSilver;
            addLogToSession(sessionId, `Account ${accountNumber} final silver balance: ${finalSilver.toLocaleString()}`);
            addLogToSession(sessionId, `Total silver spent: ${silverSpent.toLocaleString()}`);
        } catch (fundsError) {
            addLogToSession(sessionId, `Could not check final funds`, 'warning');
        }
        
        addLogToSession(sessionId, `Account ${accountNumber} processing completed!`, 'success');
        
    } catch (error) {
        addLogToSession(sessionId, `Error processing account: ${error.message}`, 'error');
        console.error('Account processing error:', error);
    }
}

// Generate final summary
function generateFinalSummary(sessionId) {
    const session = brewingSessions[sessionId];
    if (!session) return;
    
    if (session.brewingResults.length === 0) {
        addLogToSession(sessionId, 'No cards were brewed in this session', 'warning');
        return;
    }
    
    addLogToSession(sessionId, '=== FINAL BREWING RESULTS SUMMARY ===', 'highlight');
    
    const uniqueCards = new Map();
    
    session.brewingResults.forEach(card => {
        const key = `${card.mintBatch}-${card.mintNumber}`;
        if (!uniqueCards.has(key)) {
            uniqueCards.set(key, card);
        }
    });
    
    const sortedCards = Array.from(uniqueCards.values()).sort((a, b) => {
        const numA = parseInt(a.mintNumber) || 0;
        const numB = parseInt(b.mintNumber) || 0;
        return numA - numB;
    });
    
    addLogToSession(sessionId, `Total unique cards brewed: ${sortedCards.length}`);
    addLogToSession(sessionId, `Lowest mint brewed: ${sortedCards[0]?.mintBatch || ''}${sortedCards[0]?.mintNumber || 'N/A'}`);
    addLogToSession(sessionId, `Highest mint brewed: ${sortedCards[sortedCards.length-1]?.mintBatch || ''}${sortedCards[sortedCards.length-1]?.mintNumber || 'N/A'}`);
    
    addLogToSession(sessionId, 'All brewed cards (sorted by mint number):', 'summary-header');
    
    sortedCards.forEach(card => {
        addLogToSession(sessionId, `  ${card.mintBatch || ''}${card.mintNumber || 'N/A'} (Rating: ${card.rating || 'N/A'})`, 'small-font');
    });
}

// Check user funds - FIXED: using direct API call instead of proxy
async function checkUserFunds(authToken) {
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = '/user/funds';
    
    try {
        const response = await makeDirectApiCall(endpoint, 'GET', headers);
        
        if (response.data?.success && response.data?.data?.silvercoins !== undefined) {
            return response.data.data.silvercoins;
        } else {
            throw new Error('Invalid response format');
        }
    } catch (error) {
        console.error('Error checking user funds:', error);
        throw error;
    }
}

// Get collection cards with details - FIXED: using direct API call
async function getCollectionCardsWithDetails(authToken, senderID, collectionId, minMintNumber) {
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = `/collections/${collectionId}/users/${senderID}/owned2`;
    
    try {
        const response = await makeDirectApiCall(endpoint, 'GET', headers);
        
        let cards = [];
        
        if (response.data?.data?.cards) {
            cards = response.data.data.cards;
        } else if (Array.isArray(response.data?.data)) {
            cards = response.data.data;
        } else if (Array.isArray(response.data)) {
            cards = response.data;
        }
        
        return cards
            .filter(card => {
                if (minMintNumber && card.mintNumber) {
                    return parseInt(card.mintNumber) >= minMintNumber;
                }
                return true;
            })
            .map(card => ({
                id: card.id,
                mintBatch: card.mintBatch || '',
                mintNumber: card.mintNumber || 0,
                status: card.status || 'available',
                isMarketList: card.isMarketList || false,
                ethStatus: card.ethStatus || 'none',
                bundleId: card.bundleId || null,
                rating: card.rating || 'N/A',
                collectionId: collectionId
            }));
    } catch (error) {
        console.error(`Error fetching cards for collection ${collectionId}:`, error);
        return [];
    }
}

// Process a single brew - FIXED: using direct API call
async function processBrew(sessionId, authToken, senderID, sortedCardsByRequirement, cardsWithDetails, usedCardIds, batchNumber) {
    const session = brewingSessions[sessionId];
    
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = `/crafting/plans/${session.brewingPlanId}`;
    
    const requirements = [];
    const cardsUsedInThisBrew = [];
    const cardsUsedDetails = [];
    
    for (const [requirementId, config] of Object.entries(session.requirementsConfig)) {
        const cardsNeeded = config.cardsPerBrew;
        
        const availableCards = (sortedCardsByRequirement[requirementId] || [])
            .filter(cardId => !usedCardIds.has(cardId));
        
        if (availableCards.length < cardsNeeded) {
            throw new Error(`Not enough unused cards for requirement ${requirementId}`);
        }
        
        const selectedCardIds = availableCards.slice(0, cardsNeeded);
        
        selectedCardIds.forEach(cardId => {
            usedCardIds.add(cardId);
            const cardDetails = cardsWithDetails[cardId];
            cardsUsedInThisBrew.push(cardId);
            cardsUsedDetails.push({
                id: cardId,
                requirementId,
                mintBatch: cardDetails?.mintBatch || '',
                mintNumber: cardDetails?.mintNumber || 'N/A'
            });
        });
        
        requirements.push({
            requirementId: parseInt(requirementId),
            entityIds: selectedCardIds
        });
    }
    
    addLogToSession(sessionId, `Using cards with mints: ${cardsUsedDetails.map(c => `${c.mintBatch || ''}${c.mintNumber}`).join(', ')}`, 'small-font');
    
    const brewingBody = {
        requirements: requirements,
        silvercoins: session.silvercoins
    };
    
    try {
        const response = await makeDirectApiCall(endpoint, 'POST', headers, brewingBody);
        
        if (!response.data.success) {
            cardsUsedInThisBrew.forEach(cardId => usedCardIds.delete(cardId));
            addLogToSession(sessionId, `Brewing failed: ${JSON.stringify(response.data.error || response.data)}`, 'error');
            return { success: false };
        }
        
        addLogToSession(sessionId, `Brewing request successful!`, 'success');
        
        const slots = response.data.data?.slots || [];
        
        if (!slots || slots.length === 0) {
            addLogToSession(sessionId, `No slots found in response`, 'warning');
            return { success: true, cardsReceived: [] };
        }
        
        addLogToSession(sessionId, `Found ${slots.length} slots to open`);
        
        const cardsReceived = [];
        
        for (let i = 0; i < slots.length; i++) {
            if (session.stopRequested) break;
            
            const slotId = slots[i].id;
            addLogToSession(sessionId, `Opening slot ${i + 1}...`);
            
            try {
                const slotResult = await openSlot(authToken, slotId);
                
                if (slotResult && slotResult.success) {
                    if (slotResult.data?.cards?.length > 0) {
                        const card = slotResult.data.cards[0];
                        const cardInfo = `${card.mintBatch || ''}${card.mintNumber || ''}`.trim();
                        const rating = card.rating || 'N/A';
                        
                        addLogToSession(sessionId, `Slot ${i + 1}: Got ${cardInfo} with rating ${rating}`, 'success');
                        
                        cardsReceived.push({
                            mintBatch: card.mintBatch || '',
                            mintNumber: card.mintNumber || 'N/A',
                            rating: rating
                        });
                    } else {
                        addLogToSession(sessionId, `Slot ${i + 1} opened successfully`, 'success');
                    }
                } else {
                    throw new Error(`Slot open failed: ${JSON.stringify(slotResult)}`);
                }
                
                if (i < slots.length - 1) {
                    await delay(2000);
                }
                
            } catch (error) {
                addLogToSession(sessionId, `Error opening slot ${i + 1}: ${error.message}`, 'error');
            }
        }
        
        addLogToSession(sessionId, `Brew ${batchNumber} completed successfully!`, 'success');
        return { success: true, cardsReceived };
        
    } catch (error) {
        addLogToSession(sessionId, `Error in brew ${batchNumber}: ${error.message}`, 'error');
        return { success: false };
    }
}

// Open a slot - FIXED: using direct API call
async function openSlot(authToken, slotId) {
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = `/crafting/slots/${slotId}/open-instant`;
    
    try {
        const response = await makeDirectApiCall(endpoint, 'POST', headers);
        return response.data;
    } catch (error) {
        console.error(`Error opening slot ${slotId}:`, error);
        throw error;
    }
}

// Calculate brewable batches
function calculateBrewableBatches(cardsByRequirement, requirementsConfig, maxBrews) {
    let maxPossibleBrews = maxBrews;
    
    for (const [requirementId, cards] of Object.entries(cardsByRequirement)) {
        const cardsNeededPerBrew = requirementsConfig[requirementId].cardsPerBrew;
        const possibleBrewsForRequirement = Math.floor(cards.length / cardsNeededPerBrew);
        
        if (possibleBrewsForRequirement < maxPossibleBrews) {
            maxPossibleBrews = possibleBrewsForRequirement;
        }
    }
    
    return maxPossibleBrews;
}

// Find lowest mint to be used
async function findLowestMintToBeUsed(cardsByRequirement, cardsWithDetails, requirementsConfig, batches) {
    const usedMints = [];
    
    for (const [requirementId, cardIds] of Object.entries(cardsByRequirement)) {
        const cardsNeeded = requirementsConfig[requirementId].cardsPerBrew * batches;
        
        const cardsWithMints = cardIds
            .map(id => cardsWithDetails[id])
            .filter(card => card && card.mintNumber)
            .sort((a, b) => b.mintNumber - a.mintNumber);
        
        const usedForRequirement = cardsWithMints.slice(-cardsNeeded);
        usedMints.push(...usedForRequirement.map(card => card.mintNumber));
    }
    
    if (usedMints.length === 0) return 'N/A';
    
    const lowestMint = Math.min(...usedMints);
    return lowestMint;
}

// Sort cards by mint number descending
function sortCardsByMintDesc(cardsByRequirement, cardsWithDetails) {
    const sorted = {};
    
    for (const [requirementId, cardIds] of Object.entries(cardsByRequirement)) {
        const cardsWithMints = cardIds
            .map(id => ({ id, details: cardsWithDetails[id] }))
            .filter(item => item.details && item.details.mintNumber)
            .sort((a, b) => b.details.mintNumber - a.details.mintNumber);
        
        sorted[requirementId] = cardsWithMints.map(item => item.id);
    }
    
    return sorted;
}

// Helper function for delays
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        apiConfigured: !!API_BASE,
        activeSessions: Object.keys(brewingSessions).length
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API Base: ${API_BASE}`);
});