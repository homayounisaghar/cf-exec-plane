import os
import benchmark as b
from synthetic_holdout import CASES

b.BASE_CASES = CASES

import hybrid_broad as h

if __name__ == "__main__":
    os.environ.setdefault("OUT_DIR", "artifacts/onshape-fast-router-synthetic-holdout-v05")
    raise SystemExit(h.main())
