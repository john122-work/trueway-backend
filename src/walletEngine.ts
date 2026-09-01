import { pool } from './db';

export interface WalletTransaction {
  userId: string;
  amountPaise: number;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'BET_PLACED' | 'BET_WON' | 'BET_REFUND';
  referenceId?: string;
  description?: string;
}

export class WalletEngine {
  /**
   * Executes an atomic balance update with ledger entry and row locking.
   */
  static async updateBalance(txData: WalletTransaction): Promise<{ success: boolean; newBalance: number; error?: string }> {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Lock user row for update to prevent concurrent race conditions
      const userRes = await client.query(
        'SELECT wallet_balance_paise FROM users WHERE id = $1 FOR UPDATE',
        [txData.userId]
      );

      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, newBalance: 0, error: 'User not found' };
      }

      const currentBalance = parseInt(userRes.rows[0].wallet_balance_paise, 10);

      // 2. Check sufficient funds for deductions
      if (['WITHDRAWAL', 'BET_PLACED'].includes(txData.type) && currentBalance < txData.amountPaise) {
        await client.query('ROLLBACK');
        return { success: false, newBalance: currentBalance, error: 'Insufficient balance' };
      }

      // 3. Calculate new balance based on transaction type
      let netChange = txData.amountPaise;
      if (['WITHDRAWAL', 'BET_PLACED'].includes(txData.type)) {
        netChange = -txData.amountPaise;
      }

      const newBalance = currentBalance + netChange;

      // 4. Update user balance
      await client.query(
        'UPDATE users SET wallet_balance_paise = $1, updated_at = NOW() WHERE id = $2',
        [newBalance, txData.userId]
      );

      // 5. Create ledger audit entry
      await client.query(
        `INSERT INTO wallet_ledger (user_id, amount_paise, type, reference_id, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [txData.userId, txData.amountPaise, txData.type, txData.referenceId || null, txData.description || null]
      );

      await client.query('COMMIT');
      return { success: true, newBalance };

    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('Wallet transaction failed:', error);
      return { success: false, newBalance: 0, error: error.message || 'Transaction failed' };
    } finally {
      client.release();
    }
  }
}
