import { Router, Request, Response } from 'express';
import { pool } from './db';
import { WalletEngine } from './walletEngine';

const router = Router();

// Get all sports matches (case-insensitive status handling)
router.get('/matches', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM matches 
       WHERE LOWER(status::text) = 'upcoming' 
       ORDER BY start_time ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch matches error:', error);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Place a sports bet
router.post('/bet', async (req: Request, res: Response): Promise<void> => {
  const { userId, matchId, outcome, stakePaise, odds } = req.body;

  if (!userId || !matchId || !outcome || !stakePaise || !odds) {
    res.status(400).json({ error: 'Missing required bet parameters.' });
    return;
  }

  // 1. Deduct funds from user wallet using atomic wallet engine
  const walletResult = await WalletEngine.updateBalance({
    userId,
    amountPaise: stakePaise,
    type: 'BET_PLACED',
    description: `Placed bet on match ${matchId} for outcome ${outcome}`
  });

  if (!walletResult.success) {
    res.status(400).json({ error: walletResult.error });
    return;
  }

  // 2. Record the bet in the database
  try {
    const potentialPayoutPaise = Math.floor(stakePaise * odds);
    const result = await pool.query(
      `INSERT INTO bets (user_id, match_id, outcome, stake_paise, odds, potential_payout_paise, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
       RETURNING *`,
      [userId, matchId, outcome, stakePaise, odds, potentialPayoutPaise]
    );

    res.status(201).json({
      message: 'Bet placed successfully',
      bet: result.rows[0],
      newBalance: walletResult.newBalance
    });
  } catch (error) {
    console.error('Bet creation error:', error);
    // Refund wallet if DB record fails
    await WalletEngine.updateBalance({
      userId,
      amountPaise: stakePaise,
      type: 'BET_REFUND',
      description: `Refund failed bet on match ${matchId}`
    });
    res.status(500).json({ error: 'Failed to record bet' });
  }
});

export default router;
