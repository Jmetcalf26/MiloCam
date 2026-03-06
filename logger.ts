/**
 * Simple Logger Module
 * Provides standardized logging with support for a global DEBUG flag.
 */

// Toggle via DEBUG=true environment variable
const DEBUG = process.env.DEBUG === 'true';

export const logger = {
  /**
   * Logs a debug message if the global DEBUG flag is enabled.
   */
  debug: (...args: any[]) => {
    if (DEBUG) {
      console.log('[DEBUG]', ...args);
    }
  },
  
  /**
   * Standard info log, always enabled.
   */
  info: (...args: any[]) => {
    console.log('[INFO]', ...args);
  },
  
  /**
   * Standard warning log, always enabled.
   */
  warn: (...args: any[]) => {
    console.warn('[WARN]', ...args);
  },
  
  /**
   * Standard error log, always enabled.
   */
  error: (...args: any[]) => {
    console.error('[ERROR]', ...args);
  }
};

export default logger;
