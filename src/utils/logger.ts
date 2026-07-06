export const logger = {
  info: (message: string, context?: Record<string, any>) => {
    console.log(`[INFO] ${message}`, context ? JSON.stringify(context) : "");
  },

  warn: (message: string, context?: Record<string, any>) => {
    console.warn(`[WARN] ${message}`, context ? JSON.stringify(context) : "");
  },

  error: (message: string, error?: any) => {
    console.error(`[ERROR] ${message}`, error instanceof Error ? error.message : error);
  },

  debug: (message: string, context?: Record<string, any>) => {
    if (process.env.DEBUG) {
      console.debug(`[DEBUG] ${message}`, context ? JSON.stringify(context) : "");
    }
  },
};