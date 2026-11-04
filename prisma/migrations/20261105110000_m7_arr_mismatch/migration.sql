-- M7 A6 (D9): revenue events that disagree with the contract in force become data-quality items.
ALTER TYPE "DataQualityKind" ADD VALUE 'ARR_MISMATCH';
