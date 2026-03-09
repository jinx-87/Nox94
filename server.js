const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables (set these in Render dashboard)
const API_BASE = process.env.API_BASE || 'https://api.kolex.gg/api/v1'; // Default to Kolex API
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

// Proxy endpoint - all URLs are constructed server-side
app.post('/proxy', async (req, res) => {
    const { endpoint, method, headers, data } = req.body;
    
    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
    }

    // Construct full URL server-side using environment variable
    const url = `${API_BASE}${endpoint}`;
    
    // Validate that we're only calling API
    if (!url.startsWith(API_BASE)) {
        return res.status(403).json({ error: 'Invalid endpoint' });
    }

    // Prepare headers
    const proxyHeaders = {
        ...headers,
        'User-Agent': 'Brewing-Master/1.0',
    };

    // Remove headers that might cause issues
    delete proxyHeaders['host'];
    delete proxyHeaders['origin'];
    delete proxyHeaders['referer'];

    try {
        const response = await axios({
            url: url,
            method: method || 'GET',
            headers: proxyHeaders,
            data: data,
            timeout: REQUEST_TIMEOUT,
            validateStatus: null
        });

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
        brewingResults: [], // Store all brewing results for summary
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
        logs: session.logs.slice(-50), // Last 50 logs
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
        // Remove sessions older than 24 hours
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
        // Process each account
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
            
            // Delay between accounts
            if (accountIndex < session.authTokens.length - 1 && !session.stopRequested) {
                await delay(session.operationDelay);
            }
        }
        
        if (!session.stopRequested) {
            session.status = 'completed';
            addLogToSession(sessionId, 'All accounts processed successfully!', 'success');
            
            // Generate final summary
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
        // Step 1: Check user funds first
        addLogToSession(sessionId, `Checking funds for account ${accountNumber}...`);
        
        let silverBalance = 0;
        try {
            silverBalance = await checkUserFunds(authToken);
            addLogToSession(sessionId, `Silver balance: ${silverBalance.toLocaleString()}`, 'success');
        } catch (fundsError) {
            addLogToSession(sessionId, `Failed to check funds: ${fundsError.message}`, 'error');
            return;
        }
        
        // Step 2: Collect cards for each requirement
        addLogToSession(sessionId, `Scanning collections for available cards...`);
        
        const cardsByRequirement = {};
        const cardsWithDetails = {}; // Store card details including mint numbers
        
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
                
                // Filter by status (only available cards)
                const availableCards = collectionCards.filter(card => 
                    card.status === 'available' && 
                    !card.isMarketList && 
                    card.ethStatus !== 'imx_locked' &&
                    card.bundleId === null
                );
                
                addLogToSession(sessionId, `  - Collection ${collectionId}: ${collectionCards.length} total, ${availableCards.length} available (min mint filter: ${session.minMintNumber})`);
                
                // Store card details
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
        
        // Step 3: Calculate maximum possible brews based on cards
        const cardBasedBatches = calculateBrewableBatches(cardsByRequirement, session.requirementsConfig, session.maxBrews);
        
        if (cardBasedBatches === 0) {
            addLogToSession(sessionId, `Not enough cards for any brewing operations`, 'error');
            return;
        }
        
        // Step 4: Calculate based on funds
        const silverPerBrew = session.silvercoins;
        const fundBasedBatches = Math.floor(silverBalance / silverPerBrew);
        
        // Show the lowest mint that will be used
        const lowestMintUsed = await findLowestMintToBeUsed(cardsByRequirement, cardsWithDetails, session.requirementsConfig, cardBasedBatches);
        
        // Store scan results for user confirmation
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
        
        // Wait for user to click proceed
        while (!session.proceedAfterScan && !session.stopRequested) {
            await delay(1000);
        }
        
        if (session.stopRequested) return;
        
        // Reset proceed flag for next account
        session.proceedAfterScan = false;
        session.scanComplete = false;
        
        // Step 5: Determine actual batches
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
        
        // Keep track of used cards to prevent reuse
        const usedCardIds = new Set();
        
        // Sort cards by mint number (high to low) for each requirement
        const sortedCardsByRequirement = sortCardsByMintDesc(cardsByRequirement, cardsWithDetails);
        
        // Step 6: Process each brewing batch
        for (let batchNum = 1; batchNum <= actualBatches; batchNum++) {
            if (session.stopRequested) break;
            
            while (session.pauseRequested && !session.stopRequested) {
                await delay(1000);
            }
            
            addLogToSession(sessionId, `Processing brew ${batchNum}/${actualBatches}...`, 'brew-header');
            
            // Check funds before each brew
            try {
                const currentSilver = await checkUserFunds(authToken);
                if (currentSilver < silverPerBrew) {
                    addLogToSession(sessionId, `Insufficient funds for next brew (balance: ${currentSilver.toLocaleString()})`, 'error');
                    break;
                }
            } catch (fundsError) {
                addLogToSession(sessionId, `Could not verify funds before brew ${batchNum}`, 'warning');
            }
            
            // Process the brew
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
            
            // Update session progress
            session.progress = ((accountIndex * 100) + (batchNum / actualBatches * 100)) / session.authTokens.length;
            
            // Delay between brews
            if (batchNum < actualBatches && !session.stopRequested) {
                await delay(session.operationDelay);
            }
        }
        
        // Check final funds
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

// Generate final summary of all brewed cards
function generateFinalSummary(sessionId) {
    const session = brewingSessions[sessionId];
    if (!session) return;
    
    if (session.brewingResults.length === 0) {
        addLogToSession(sessionId, 'No cards were brewed in this session', 'warning');
        return;
    }
    
    addLogToSession(sessionId, '=== FINAL BREWING RESULTS SUMMARY ===', 'highlight');
    
    // Group by mint number to handle duplicates (slot1 and slot2 same card)
    const uniqueCards = new Map();
    
    session.brewingResults.forEach(card => {
        const key = `${card.mintBatch}-${card.mintNumber}`;
        if (!uniqueCards.has(key)) {
            uniqueCards.set(key, card);
        }
    });
    
    // Convert to array and sort by mint number
    const sortedCards = Array.from(uniqueCards.values()).sort((a, b) => {
        // Extract numeric part for sorting
        const numA = parseInt(a.mintNumber) || 0;
        const numB = parseInt(b.mintNumber) || 0;
        return numA - numB;
    });
    
    addLogToSession(sessionId, `Total unique cards brewed: ${sortedCards.length}`);
    addLogToSession(sessionId, `Lowest mint brewed: ${sortedCards[0]?.mintBatch || ''}${sortedCards[0]?.mintNumber || 'N/A'}`);
    addLogToSession(sessionId, `Highest mint brewed: ${sortedCards[sortedCards.length-1]?.mintBatch || ''}${sortedCards[sortedCards.length-1]?.mintNumber || 'N/A'}`);
    
    // Show all brewed cards sorted by mint number (smaller font in UI)
    addLogToSession(sessionId, 'All brewed cards (sorted by mint number):', 'summary-header');
    
    sortedCards.forEach(card => {
        addLogToSession(sessionId, `  ${card.mintBatch || ''}${card.mintNumber || 'N/A'} (Rating: ${card.rating || 'N/A'})`, 'small-font');
    });
}

// Check user funds
async function checkUserFunds(authToken) {
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = '/user/funds';
    
    try {
        const response = await axios.post('http://localhost:3000/proxy', {
            endpoint,
            method: 'GET',
            headers
        });
        
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

// Get collection cards with full details
async function getCollectionCardsWithDetails(authToken, senderID, collectionId, minMintNumber) {
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = `/collections/${collectionId}/users/${senderID}/owned2`;
    
    try {
        const response = await axios.post('http://localhost:3000/proxy', {
            endpoint,
            method: 'GET',
            headers
        });
        
        let cards = [];
        
        // Handle different response structures
        if (response.data?.data?.cards) {
            cards = response.data.data.cards;
        } else if (Array.isArray(response.data?.data)) {
            cards = response.data.data;
        } else if (Array.isArray(response.data)) {
            cards = response.data;
        }
        
        // Process each card to extract mint number and status
        return cards
            .filter(card => {
                // Filter by mint number if specified
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

// Find the lowest mint that will be used
async function findLowestMintToBeUsed(cardsByRequirement, cardsWithDetails, requirementsConfig, batches) {
    // For each requirement, take the cards that would be used
    const usedMints = [];
    
    for (const [requirementId, cardIds] of Object.entries(cardsByRequirement)) {
        const cardsNeeded = requirementsConfig[requirementId].cardsPerBrew * batches;
        
        // Get cards for this requirement with their mint numbers
        const cardsWithMints = cardIds
            .map(id => cardsWithDetails[id])
            .filter(card => card && card.mintNumber)
            .sort((a, b) => b.mintNumber - a.mintNumber); // Sort high to low
        
        // Take the lowest mints that will be used (the ones at the end of the sorted list)
        const usedForRequirement = cardsWithMints.slice(-cardsNeeded);
        usedMints.push(...usedForRequirement.map(card => card.mintNumber));
    }
    
    if (usedMints.length === 0) return 'N/A';
    
    // Find the minimum mint number among used cards
    const lowestMint = Math.min(...usedMints);
    return lowestMint;
}

// Sort cards by mint number descending (high to low)
function sortCardsByMintDesc(cardsByRequirement, cardsWithDetails) {
    const sorted = {};
    
    for (const [requirementId, cardIds] of Object.entries(cardsByRequirement)) {
        // Get cards with their mint numbers
        const cardsWithMints = cardIds
            .map(id => ({ id, details: cardsWithDetails[id] }))
            .filter(item => item.details && item.details.mintNumber)
            .sort((a, b) => b.details.mintNumber - a.details.mintNumber); // Sort high to low
        
        sorted[requirementId] = cardsWithMints.map(item => item.id);
    }
    
    return sorted;
}

// Process a single brew
async function processBrew(sessionId, authToken, senderID, sortedCardsByRequirement, cardsWithDetails, usedCardIds, batchNumber) {
    const session = brewingSessions[sessionId];
    
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = `/crafting/plans/${session.brewingPlanId}`;
    
    // Build requirements array using sorted cards
    const requirements = [];
    const cardsUsedInThisBrew = [];
    const cardsUsedDetails = [];
    
    for (const [requirementId, config] of Object.entries(session.requirementsConfig)) {
        const cardsNeeded = config.cardsPerBrew;
        
        // Get available cards (not used yet)
        const availableCards = (sortedCardsByRequirement[requirementId] || [])
            .filter(cardId => !usedCardIds.has(cardId));
        
        if (availableCards.length < cardsNeeded) {
            throw new Error(`Not enough unused cards for requirement ${requirementId}`);
        }
        
        // Take the first N cards (which are the highest mints due to sorting)
        const selectedCardIds = availableCards.slice(0, cardsNeeded);
        
        // Mark these cards as used and store details
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
    
    // Log the mints being used
    addLogToSession(sessionId, `Using cards with mints: ${cardsUsedDetails.map(c => `${c.mintBatch || ''}${c.mintNumber}`).join(', ')}`, 'small-font');
    
    const brewingBody = {
        requirements: requirements,
        silvercoins: session.silvercoins
    };
    
    try {
        const response = await axios.post('http://localhost:3000/proxy', {
            endpoint,
            method: 'POST',
            headers,
            data: brewingBody
        });
        
        if (!response.data.success) {
            // If brewing fails, "unuse" the cards
            cardsUsedInThisBrew.forEach(cardId => usedCardIds.delete(cardId));
            addLogToSession(sessionId, `Brewing failed: ${JSON.stringify(response.data.error || response.data)}`, 'error');
            return { success: false };
        }
        
        addLogToSession(sessionId, `Brewing request successful!`, 'success');
        
        // Process slots from the response
        const slots = response.data.data?.slots || [];
        
        if (!slots || slots.length === 0) {
            addLogToSession(sessionId, `No slots found in response`, 'warning');
            return { success: true, cardsReceived: [] };
        }
        
        addLogToSession(sessionId, `Found ${slots.length} slots to open`);
        
        const cardsReceived = [];
        
        // Open each slot
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

// Open a slot
async function openSlot(authToken, slotId) {
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': authToken
    };
    
    const endpoint = `/crafting/slots/${slotId}/open-instant`;
    
    try {
        const response = await axios.post('http://localhost:3000/proxy', {
            endpoint,
            method: 'POST',
            headers
        });
        
        return response.data;
    } catch (error) {
        console.error(`Error opening slot ${slotId}:`, error);
        throw error;
    }
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