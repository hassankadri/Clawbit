"""Configure Neon Object Storage CORS for browser-side signed uploads.

Run once for the Neon branch whose credentials and bucket are configured in the
environment. The rule permits only the exact HTTPS frontend origin.
"""

import os
import sys

from object_storage import configure_bucket_cors


def main() -> int:
    origin = os.getenv("CLAWBIT_FRONTEND_URL", "").strip()
    if not origin:
        print("Set CLAWBIT_FRONTEND_URL to the exact HTTPS frontend origin.", file=sys.stderr)
        return 1

    try:
        configure_bucket_cors(origin)
    except Exception as exc:
        print(f"Object Storage CORS setup failed: {type(exc).__name__}", file=sys.stderr)
        return 1

    print("Private bucket CORS is restricted to the configured frontend origin.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
