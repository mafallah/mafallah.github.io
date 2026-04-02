#!/usr/bin/env python3
"""
Download US homeownership rates by age of householder.

Sources
-------
1. Census HVS Historical Table 19 (tab19.xlsx)
   Quarterly homeownership rates by age of householder, 1994–present.
   Age groups: <35, 35–44, 45–54, 55–64, 65+
   URL: https://www.census.gov/housing/hvs/data/tab19.xlsx

2. Census HVS Historical Table 15 (tab15.xlsx)
   Annual housing inventory counts (owner-occupied + total occupied) by
   age of householder, 1982–present.  Used to derive annual homeownership
   rates that extend the series back to 1982.
   URL: https://www.census.gov/housing/hvs/data/tab15.xlsx

Together these cover 1982–present with age groups:
    under_35 | 35_to_44 | 45_to_54 | 55_to_64 | 65_and_over

Output files
------------
data/tab19_raw.xlsx                – raw Census Table 19 download
data/tab15_raw.xlsx                – raw Census Table 15 download
data/homeownership_by_age_raw.csv  – tidy combined dataset

Columns in the CSV
------------------
year              : calendar year (int)
quarter           : 1–4 for quarterly data; empty for annual data
age_group         : one of the five labels above
homeownership_rate: percent (0–100)
source            : "Census HVS Table 19" or "Census HVS Table 15"
frequency         : "quarterly" or "annual"

Usage
-----
    pip install requests pandas openpyxl
    python download_data.py
"""

import io
import os
import re
import sys

import requests
import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; homeownership-research/1.0)"}
TIMEOUT = 120  # seconds

HVS_TABLE19_URL = "https://www.census.gov/housing/hvs/data/tab19.xlsx"
HVS_TABLE15_URL = "https://www.census.gov/housing/hvs/data/tab15.xlsx"

# Canonical short labels for the five age groups Census uses
AGE_LABEL_MAP: dict[str, str] = {
    "under_35": [
        "less than 35", "under 35", "< 35", "less than 35 years",
        "under 35 years",
    ],
    "35_to_44": ["35 to 44", "35-44", "35–44"],
    "45_to_54": ["45 to 54", "45-54", "45–54"],
    "55_to_64": ["55 to 64", "55-64", "55–64"],
    "65_and_over": [
        "65 years and over", "65 and over", "65+", "65 or older",
        "65 years or more", "65 and older",
    ],
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def download_file(url: str, dest: str) -> bytes:
    print(f"  GET {url}")
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.content
    with open(dest, "wb") as fh:
        fh.write(data)
    print(f"  Saved {len(data):,} bytes → {dest}")
    return data


def normalize_age_label(raw: str) -> str | None:
    """Map a raw column header string to one of the five canonical age labels."""
    s = re.sub(r"[\n\r]+", " ", str(raw)).strip().lower()
    # Strip trailing footnote markers (digits, asterisks, slashes)
    s = re.sub(r"[\s\d\*/]+$", "", s).strip()
    for label, patterns in AGE_LABEL_MAP.items():
        for pat in patterns:
            if pat in s:
                return label
    return None


def find_header_row(df: pd.DataFrame) -> int:
    """
    Return the 0-based index of the first row that looks like a column
    header (contains 'year' or at least two age-range keywords).
    """
    age_kw = {"35", "44", "54", "64", "65", "under", "less", "over"}
    for i, row in df.iterrows():
        vals = {str(v).strip().lower() for v in row if pd.notna(v) and str(v).strip()}
        if "year" in vals:
            return int(i)
        if len(vals & age_kw) >= 2:
            return int(i)
    return 0


# ---------------------------------------------------------------------------
# Table 19 – quarterly homeownership rates by age, 1994–present
# ---------------------------------------------------------------------------
#
# Typical Excel layout (rows are 0-indexed):
#   0  : title
#   1  : blank
#   2  : column headers:
#          Year | Quarter | Total | Less than 35 years | 35 to 44 years | …
#   3+ : data rows  (Year is filled only on the first quarter of each year)
#
# Rates are already expressed as percentages (e.g. 63.8).


def parse_table19(raw: bytes) -> pd.DataFrame:
    df_raw = pd.read_excel(io.BytesIO(raw), sheet_name=0, header=None)

    hdr_idx = find_header_row(df_raw)
    headers = df_raw.iloc[hdr_idx].tolist()
    data = df_raw.iloc[hdr_idx + 1 :].copy().reset_index(drop=True)
    data.columns = range(len(headers))

    # Identify year and quarter columns
    year_col = qtr_col = None
    for idx, h in enumerate(headers):
        h_l = str(h).strip().lower()
        if "year" in h_l:
            year_col = idx
        elif "quarter" in h_l or h_l in ("q", "qtr"):
            qtr_col = idx

    # Fallback: col 0 = year, col 1 = quarter
    if year_col is None:
        year_col = 0
    if qtr_col is None:
        qtr_col = 1

    # Identify age-group columns
    age_cols: dict[str, int] = {}
    for idx, h in enumerate(headers):
        lbl = normalize_age_label(str(h))
        if lbl:
            age_cols[lbl] = idx

    print(f"    Header row: {hdr_idx}  |  year col: {year_col}  |  quarter col: {qtr_col}")
    print(f"    Age group columns found: {age_cols}")

    if not age_cols:
        raise ValueError(
            f"No age-group columns identified in Table 19.\nHeaders: {headers}"
        )

    records = []
    current_year: int | None = None

    for _, row in data.iterrows():
        # Year column may be sparse (blank except on first quarter of each year)
        yr_val = row.iloc[year_col]
        if pd.notna(yr_val):
            yr_str = str(yr_val).strip().split(".")[0]  # strip .0 from floats
            if yr_str.isdigit() and 1960 <= int(yr_str) <= 2050:
                current_year = int(yr_str)

        if current_year is None:
            continue

        q_val = row.iloc[qtr_col]
        q_str = str(q_val).strip() if pd.notna(q_val) else ""
        m = re.search(r"([1-4])", q_str)
        if not m:
            continue
        quarter = int(m.group(1))

        for label, col_idx in age_cols.items():
            try:
                rate = float(str(row.iloc[col_idx]).replace(",", "").strip())
            except (ValueError, TypeError):
                continue
            if not (0 < rate < 100):
                continue
            records.append(
                {
                    "year": current_year,
                    "quarter": quarter,
                    "age_group": label,
                    "homeownership_rate": rate,
                    "source": "Census HVS Table 19",
                    "frequency": "quarterly",
                }
            )

    df = pd.DataFrame(records)
    print(
        f"    Parsed {len(df):,} rows  |  years {df['year'].min()}–{df['year'].max()}"
    )
    return df


# ---------------------------------------------------------------------------
# Table 15 – annual inventory counts by age, 1982–present
# ---------------------------------------------------------------------------
#
# Table 15 contains three stacked panels (all US):
#   Panel 1: Total occupied units (by age of householder, in thousands)
#   Panel 2: Owner occupied
#   Panel 3: Renter occupied
#
# Homeownership rate = owner-occupied / total-occupied × 100
#
# Each panel shares the same column structure:
#   Year | Under 35 years | 35 to 44 years | 45 to 54 years | 55 to 64 years | 65+
#
# The year column has values like 1982, 1983, … (annual, not quarterly).


def parse_table15(raw: bytes) -> pd.DataFrame:
    df_raw = pd.read_excel(io.BytesIO(raw), sheet_name=0, header=None)
    n_rows = len(df_raw)

    # ---- Find panel boundaries ----------------------------------------
    # Panels are separated by a row containing "owner" or "total occupied"
    panel_markers: list[tuple[int, str]] = []
    for i, row in df_raw.iterrows():
        line = " ".join(str(v).lower() for v in row if pd.notna(v)).strip()
        if re.search(r"\bowner.occupied\b", line):
            panel_markers.append((int(i), "owner"))
        elif re.search(r"\btotal.occupied\b", line):
            panel_markers.append((int(i), "total"))

    print(f"    Table 15 panel markers (first 6): {panel_markers[:6]}")

    if not panel_markers:
        raise ValueError("Could not locate panel markers in Table 15.")

    # ---- Helper: extract (year, age_group, count) from a panel ----------

    def extract_panel(start: int, end: int) -> pd.DataFrame:
        sub = df_raw.iloc[start:end].reset_index(drop=True)
        hdr_idx = find_header_row(sub)
        headers = sub.iloc[hdr_idx].tolist()

        age_cols: dict[str, int] = {}
        for idx, h in enumerate(headers):
            lbl = normalize_age_label(str(h))
            if lbl:
                age_cols[lbl] = idx

        if not age_cols:
            return pd.DataFrame()

        # Year is the first non-age column (usually index 0)
        year_col = 0

        records = []
        current_year: int | None = None
        for _, row in sub.iloc[hdr_idx + 1 :].iterrows():
            yr_val = row.iloc[year_col]
            if pd.notna(yr_val):
                yr_str = str(yr_val).strip().split(".")[0]
                if yr_str.isdigit() and 1960 <= int(yr_str) <= 2050:
                    current_year = int(yr_str)
            if current_year is None:
                continue
            for lbl, cidx in age_cols.items():
                try:
                    val = float(str(row.iloc[cidx]).replace(",", "").strip())
                except (ValueError, TypeError):
                    continue
                if val > 0:
                    records.append(
                        {"year": current_year, "age_group": lbl, "count": val}
                    )
        return pd.DataFrame(records)

    # ---- Extract owner and total panels --------------------------------
    owner_frames: list[pd.DataFrame] = []
    total_frames: list[pd.DataFrame] = []

    for k, (row_idx, ptype) in enumerate(panel_markers):
        end = panel_markers[k + 1][0] if k + 1 < len(panel_markers) else n_rows
        pf = extract_panel(row_idx, end)
        if ptype == "owner":
            owner_frames.append(pf)
        elif ptype == "total":
            total_frames.append(pf)

    if not owner_frames or not total_frames:
        raise ValueError(
            "Could not extract both owner-occupied and total-occupied panels from Table 15."
        )

    owner_df = (
        pd.concat(owner_frames)
        .dropna(subset=["count"])
        .groupby(["year", "age_group"])["count"]
        .mean()
        .reset_index(name="owner")
    )
    total_df = (
        pd.concat(total_frames)
        .dropna(subset=["count"])
        .groupby(["year", "age_group"])["count"]
        .mean()
        .reset_index(name="total")
    )

    merged = owner_df.merge(total_df, on=["year", "age_group"])
    merged = merged[merged["total"] > 0].copy()
    merged["homeownership_rate"] = merged["owner"] / merged["total"] * 100
    merged = merged[merged["homeownership_rate"].between(0, 100)]

    result = merged[["year", "age_group", "homeownership_rate"]].copy()
    result["quarter"] = pd.NA
    result["source"] = "Census HVS Table 15"
    result["frequency"] = "annual"

    print(
        f"    Parsed {len(result):,} rows  |  years {result['year'].min()}–{result['year'].max()}"
    )
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print("=" * 60)
    print("US Homeownership Rates by Age — Census HVS download")
    print("=" * 60)

    frames: list[pd.DataFrame] = []

    # ---- Table 19: quarterly rates 1994–present -------------------------
    print("\n[1/2] Table 19 — quarterly rates by age, 1994–present")
    try:
        raw19 = download_file(
            HVS_TABLE19_URL, dest=os.path.join(DATA_DIR, "tab19_raw.xlsx")
        )
        df19 = parse_table19(raw19)
        frames.append(df19)
    except Exception as exc:
        print(f"  ERROR: {exc}")
        sys.exit(1)

    # ---- Table 15: annual counts 1982–present ---------------------------
    print("\n[2/2] Table 15 — annual inventory counts by age, 1982–present")
    try:
        raw15 = download_file(
            HVS_TABLE15_URL, dest=os.path.join(DATA_DIR, "tab15_raw.xlsx")
        )
        df15 = parse_table15(raw15)

        # Only keep pre-quarterly years to avoid double-counting
        min_q_year = int(df19["year"].min())
        df15_pre = df15[df15["year"] < min_q_year].copy()
        print(f"    Keeping Table 15 rows for years < {min_q_year}: {len(df15_pre):,}")
        if not df15_pre.empty:
            frames.append(df15_pre)
    except Exception as exc:
        print(f"  WARNING: Table 15 failed ({exc}). Proceeding with Table 19 only.")

    # ---- Combine & save -------------------------------------------------
    combined = pd.concat(frames, ignore_index=True)
    combined["quarter"] = pd.to_numeric(combined["quarter"], errors="coerce")
    combined = combined.sort_values(
        ["age_group", "year", "quarter"]
    ).reset_index(drop=True)

    out_path = os.path.join(DATA_DIR, "homeownership_by_age_raw.csv")
    combined.to_csv(out_path, index=False)

    print(f"\n{'=' * 60}")
    print(f"Saved {len(combined):,} rows → {out_path}")
    print(f"\nYear range : {int(combined['year'].min())}–{int(combined['year'].max())}")
    print(f"Age groups : {sorted(combined['age_group'].unique())}")
    print(f"Sources    : {combined['source'].unique().tolist()}")
    print(f"\nRow counts by age group:")
    print(combined.groupby("age_group").size().to_string())
    print(f"\nSample (first 12 rows):")
    print(combined.head(12).to_string(index=False))


if __name__ == "__main__":
    main()
