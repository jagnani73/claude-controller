import type { ServerConfig } from "./types/index.js";
import {
    DEFAULT_DATA_DIR,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_PTY_COLS,
    DEFAULT_PTY_ROWS,
    DEFAULT_RING_BUFFER_SIZE,
} from "./utils/constants.js";

export function loadConfig(): ServerConfig {
    return {
        port: Number(process.env.PORT || DEFAULT_PORT),
        host: process.env.HOST || DEFAULT_HOST,
        dataDir: process.env.DATA_DIR || DEFAULT_DATA_DIR,
        pty: {
            cols: Number(process.env.PTY_COLS || DEFAULT_PTY_COLS),
            rows: Number(process.env.PTY_ROWS || DEFAULT_PTY_ROWS),
        },
        ringBufferSize: Number(
            process.env.RING_BUFFER_SIZE || DEFAULT_RING_BUFFER_SIZE,
        ),
    };
}
