"""
preprocessment.py
=================
Reads the UCI Online Retail dataset, cleans it, enriches it with derived
columns (Revenue, Category, temporal fields), and aggregates everything that
the D3 front-end needs into a single `data.json` file.

Design notes
------------
* All heavy lifting (joins, groupings, ranking) is done here so that the
  browser only has to render — not compute.
* Country coordinates are embedded directly so the client has no runtime
  geocoding to perform.
* The output schema is deliberately flat and self-describing.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pandas as pd


# --------------------------------------------------------------------------- #
#  Configuration                                                              #
# --------------------------------------------------------------------------- #
INPUT_FILE = Path("Online Retail.xlsx")       # can also be a .csv
OUTPUT_FILE = Path("data.json")
TOP_N_PRODUCTS = 15
TOP_N_CUSTOMERS = 15

# Approx. geographic centroids for the countries that appear in the dataset.
COUNTRY_COORDS: dict[str, tuple[float, float]] = {
    "United Kingdom":  (54.0, -2.0),
    "France":          (46.2, 2.2),
    "Australia":       (-25.3, 133.8),
    "Netherlands":     (52.1, 5.3),
    "Germany":         (51.2, 10.5),
    "Norway":          (60.5, 8.5),
    "EIRE":            (53.1, -7.7),
    "Switzerland":     (46.8, 8.2),
    "Spain":           (40.5, -3.7),
    "Poland":          (51.9, 19.1),
    "Portugal":        (39.4, -8.2),
    "Italy":           (41.9, 12.6),
    "Belgium":         (50.5, 4.5),
    "Lithuania":       (55.2, 23.9),
    "Japan":           (36.2, 138.2),
    "Iceland":         (65.0, -18.6),
    "Channel Islands": (49.4, -2.3),
    "Denmark":         (56.3, 9.5),
    "Cyprus":          (35.1, 33.4),
    "Sweden":          (60.1, 18.6),
    "Austria":         (47.5, 14.5),
    "Israel":          (31.0, 34.8),
    "Finland":         (61.9, 25.7),
    "Bahrain":         (25.9, 50.6),
    "Greece":          (39.1, 21.8),
    "Hong Kong":       (22.3, 114.2),
    "Singapore":       (1.35, 103.8),
    "Lebanon":         (33.9, 35.9),
    "United Arab Emirates": (23.4, 53.8),
    "Saudi Arabia":    (23.9, 45.1),
    "Czech Republic":  (49.8, 15.5),
    "Canada":          (56.1, -106.3),
    "Unspecified":     (0.0, 0.0),
    "Brazil":          (-14.2, -51.9),
    "USA":             (37.1, -95.7),
    "European Community": (50.8, 4.3),
    "Malta":           (35.9, 14.4),
    "RSA":             (-30.6, 22.9),
}

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# --------------------------------------------------------------------------- #
#  1. Load                                                                    #
# --------------------------------------------------------------------------- #
def load_dataset(path: Path) -> pd.DataFrame:
    """Load the dataset from .xlsx or .csv, whichever exists."""
    if path.suffix.lower() == ".xlsx":
        # openpyxl engine is required for .xlsx
        df = pd.read_excel(path, engine="openpyxl")
    elif path.suffix.lower() == ".csv":
        df = pd.read_csv(path, encoding="ISO-8859-1")
    else:
        raise ValueError(f"Unsupported file format: {path.suffix}")
    print(f"[load] {len(df):,} rows loaded from {path}")
    return df


# --------------------------------------------------------------------------- #
#  2. Clean                                                                   #
# --------------------------------------------------------------------------- #
def clean_dataset(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Clean and split the data into (sales_df, cancellations_df)."""
    initial = len(df)

    # Proper types
    df["InvoiceDate"] = pd.to_datetime(df["InvoiceDate"], errors="coerce")
    df["InvoiceNo"] = df["InvoiceNo"].astype(str)
    df["StockCode"] = df["StockCode"].astype(str)

    # Flag cancellations (InvoiceNo starts with 'C')
    df["is_cancellation"] = df["InvoiceNo"].str.startswith("C")

    # Drop rows without a CustomerID / Description / date — unattributable
    df = df.dropna(subset=["CustomerID", "Description", "InvoiceDate"])
    df["CustomerID"] = df["CustomerID"].astype(int).astype(str)

    # Remove exact duplicates
    df = df.drop_duplicates()

    # Derived temporal & category columns — computed for BOTH splits
    df["Year"] = df["InvoiceDate"].dt.year
    df["MonthNum"] = df["InvoiceDate"].dt.month
    df["Month"] = df["MonthNum"].apply(lambda m: MONTH_NAMES[m - 1])
    df["Quarter"] = "Q" + df["InvoiceDate"].dt.quarter.astype(str)
    df["Category"] = df["Description"].apply(classify_category)
    df["Description"] = df["Description"].str.strip()

    # Split
    cancellations = df[df["is_cancellation"]].copy()
    sales = df[~df["is_cancellation"]].copy()

    # Sales pipeline: keep only rows with positive economics
    sales = sales[(sales["Quantity"] > 0) & (sales["UnitPrice"] > 0)]
    sales["Revenue"] = sales["Quantity"] * sales["UnitPrice"]

    print(f"[clean] sales: {len(sales):,}  cancellations: {len(cancellations):,} "
          f"(removed {initial - len(sales) - len(cancellations):,})")
    return sales, cancellations


def classify_category(description: object) -> str:
    """Apply the keyword rules from the brief to derive a category."""
    if not isinstance(description, str):
        return "Other"
    d = description.upper()
    if "BAG" in d:
        return "Bags"
    if "CLOCK" in d:
        return "Clocks"
    if "BOX" in d or "TIN" in d:
        return "Storage"
    if "MUG" in d or "CUP" in d:
        return "Mugs & Cups"
    if "CHRISTMAS" in d or "XMAS" in d:
        return "Christmas"
    if "CAKE" in d or "BAKING" in d:
        return "Bakeware"
    if "GARDEN" in d or "PLANT" in d:
        return "Garden"
    if "CARD" in d or "WRAP" in d:
        return "Cards & Wrap"
    if "LIGHT" in d or "LAMP" in d:
        return "Lighting"
    if "CANDLE" in d or "HOLDER" in d:
        return "Candles & Holders"
    return "Other"


# --------------------------------------------------------------------------- #
#  3. Aggregate                                                               #
# --------------------------------------------------------------------------- #
def build_kpis(df: pd.DataFrame) -> dict:
    total_revenue = float(df["Revenue"].sum())
    total_orders = int(df["InvoiceNo"].nunique())
    total_customers = int(df["CustomerID"].nunique())
    total_units = int(df["Quantity"].sum())
    return {
        "totalRevenue":     total_revenue,
        "totalOrders":      total_orders,
        "totalCustomers":   total_customers,
        "totalUnitsSold":   total_units,
        "avgOrderValue":    total_revenue / total_orders if total_orders else 0.0,
        "revenuePerCustomer": total_revenue / total_customers if total_customers else 0.0,
    }


def revenue_by_month(df: pd.DataFrame) -> list[dict]:
    grp = df.groupby("MonthNum", as_index=False)["Revenue"].sum()
    grp["month"] = grp["MonthNum"].apply(lambda m: MONTH_NAMES[m - 1])
    grp = grp.sort_values("MonthNum")
    return [
        {"month": row.month, "monthNum": int(row.MonthNum), "revenue": float(row.Revenue)}
        for row in grp.itertuples()
    ]


def revenue_by_quarter(df: pd.DataFrame) -> list[dict]:
    grp = df.groupby("Quarter", as_index=False)["Revenue"].sum()
    total = grp["Revenue"].sum()
    grp = grp.sort_values("Quarter")
    return [
        {
            "quarter": row.Quarter,
            "revenue": float(row.Revenue),
            "percentage": float(row.Revenue / total * 100) if total else 0.0,
        }
        for row in grp.itertuples()
    ]


def revenue_by_country(df: pd.DataFrame, exclude_uk: bool = True) -> list[dict]:
    data = df if not exclude_uk else df[df["Country"] != "United Kingdom"]
    grp = (
        data.groupby("Country", as_index=False)["Revenue"]
        .sum()
        .sort_values("Revenue", ascending=False)
    )
    return [
        {"country": row.Country, "revenue": float(row.Revenue)}
        for row in grp.itertuples()
    ]


def category_breakdown(df: pd.DataFrame) -> list[dict]:
    grp = (
        df.groupby("Category", as_index=False)
        .agg(revenue=("Revenue", "sum"),
             unitsSold=("Quantity", "sum"),
             products=("StockCode", "nunique"))
        .sort_values("revenue", ascending=False)
    )
    return [
        {
            "category":  row.Category,
            "revenue":   float(row.revenue),
            "unitsSold": int(row.unitsSold),
            "products":  int(row.products),
        }
        for row in grp.itertuples()
    ]


def top_products(df: pd.DataFrame, n: int, by: str) -> list[dict]:
    agg = (
        df.groupby(["StockCode", "Description"], as_index=False)
        .agg(unitsSold=("Quantity", "sum"),
             revenue=("Revenue", "sum"))
    )
    agg = agg.sort_values(by, ascending=False).head(n)
    return [
        {
            "stockCode":  row.StockCode,
            "description": row.Description,
            "unitsSold":  int(row.unitsSold),
            "revenue":    float(row.revenue),
        }
        for row in agg.itertuples()
    ]


def customers_by_country(df: pd.DataFrame, exclude_uk: bool = True) -> list[dict]:
    data = df if not exclude_uk else df[df["Country"] != "United Kingdom"]
    grp = (
        data.groupby("Country", as_index=False)
        .agg(customers=("CustomerID", "nunique"),
             revenue=("Revenue", "sum"),
             orders=("InvoiceNo", "nunique"))
        .sort_values("customers", ascending=False)
    )
    out = []
    for row in grp.itertuples():
        lat, lng = COUNTRY_COORDS.get(row.Country, (0.0, 0.0))
        out.append({
            "country":   row.Country,
            "customers": int(row.customers),
            "revenue":   float(row.revenue),
            "orders":    int(row.orders),
            "lat":       lat,
            "lng":       lng,
        })
    return out


def top_customers(df: pd.DataFrame, n: int) -> list[dict]:
    grp = (
        df.groupby(["CustomerID", "Country"], as_index=False)
        .agg(revenue=("Revenue", "sum"),
             orders=("InvoiceNo", "nunique"))
        .sort_values("revenue", ascending=False)
        .head(n)
    )
    return [
        {
            "customerId": row.CustomerID,
            "country":    row.Country,
            "revenue":    float(row.revenue),
            "orders":     int(row.orders),
        }
        for row in grp.itertuples()
    ]


def customers_by_month(df: pd.DataFrame) -> list[dict]:
    grp = (
        df.groupby("MonthNum", as_index=False)["CustomerID"].nunique()
        .rename(columns={"CustomerID": "customers"})
        .sort_values("MonthNum")
    )
    grp["month"] = grp["MonthNum"].apply(lambda m: MONTH_NAMES[m - 1])
    return [
        {"month": row.month, "monthNum": int(row.MonthNum), "customers": int(row.customers)}
        for row in grp.itertuples()
    ]


# --------------------------------------------------------------------------- #
#  3b. Extended aggregations (Insights panel)                                 #
# --------------------------------------------------------------------------- #
def cancellations_by_category(sales: pd.DataFrame,
                              cancel: pd.DataFrame) -> list[dict]:
    """Cancellation rate = |cancel_qty| / (sales_qty + |cancel_qty|) per category."""
    sales_qty = sales.groupby("Category")["Quantity"].sum()
    cancel_qty = cancel.groupby("Category")["Quantity"].sum().abs()

    out = []
    for cat in sorted(set(sales_qty.index) | set(cancel_qty.index)):
        s = int(sales_qty.get(cat, 0))
        c = int(cancel_qty.get(cat, 0))
        total = s + c
        out.append({
            "category": cat,
            "salesUnits": s,
            "cancelledUnits": c,
            "cancelRate": (c / total) if total else 0.0,
        })
    # Sort descending by cancellation rate for readability
    out.sort(key=lambda d: d["cancelRate"], reverse=True)
    return out


def cancellations_by_month(sales: pd.DataFrame,
                           cancel: pd.DataFrame) -> list[dict]:
    """Cancellation rate per month across the reporting period."""
    sales_qty = sales.groupby("MonthNum")["Quantity"].sum()
    cancel_qty = cancel.groupby("MonthNum")["Quantity"].sum().abs()

    out = []
    for m in range(1, 13):
        s = int(sales_qty.get(m, 0))
        c = int(cancel_qty.get(m, 0))
        total = s + c
        out.append({
            "monthNum": m,
            "month":       MONTH_NAMES[m - 1],
            "salesUnits":  s,
            "cancelledUnits": c,
            "cancelRate":  (c / total) if total else 0.0,
        })
    return out


def product_pairs(df: pd.DataFrame, top_n: int = 20) -> list[dict]:
    """
    Market-basket analysis: top N pairs of products that co-occur on the
    same invoice most frequently. Runs in O(invoices * items^2) where
    items is the basket size, so modest for 20K invoices.
    """
    from itertools import combinations
    from collections import Counter

    # Group products per invoice
    baskets = df.groupby("InvoiceNo")["Description"].apply(
        lambda s: sorted(s.dropna().unique())
    )
    counter: Counter = Counter()
    for items in baskets:
        if len(items) < 2:
            continue
        # Cap per-invoice combinations to avoid pathological baskets
        if len(items) > 25:
            items = items[:25]
        for pair in combinations(items, 2):
            counter[pair] += 1

    top = counter.most_common(top_n)
    return [
        {"productA": a, "productB": b, "count": int(c)}
        for (a, b), c in top
    ]


# --------------------------------------------------------------------------- #
#  4. Orchestration                                                           #
# --------------------------------------------------------------------------- #
def build_payload(sales: pd.DataFrame, cancel: pd.DataFrame) -> dict:
    return {
        "meta": {
            "rows":            int(len(sales)),
            "cancellations":   int(len(cancel)),
            "dateFrom":        sales["InvoiceDate"].min().strftime("%Y-%m-%d"),
            "dateTo":          sales["InvoiceDate"].max().strftime("%Y-%m-%d"),
            "currency":        "GBP",
        },
        "kpis":                 build_kpis(sales),
        "revenueByMonth":       revenue_by_month(sales),
        "revenueByQuarter":     revenue_by_quarter(sales),
        "revenueByCountry":     revenue_by_country(sales, exclude_uk=True),
        "categoryBreakdown":    category_breakdown(sales),
        "topProductsByRevenue": top_products(sales, TOP_N_PRODUCTS, by="revenue"),
        "topProductsByUnits":   top_products(sales, TOP_N_PRODUCTS, by="unitsSold"),
        "customersByCountry":   customers_by_country(sales, exclude_uk=True),
        "topCustomers":         top_customers(sales, TOP_N_CUSTOMERS),
        "customersByMonth":     customers_by_month(sales),
        # --- Insights panel additions ---
        "cancellationsByCategory": cancellations_by_category(sales, cancel),
        "cancellationsByMonth":    cancellations_by_month(sales, cancel),
        "productPairs":            product_pairs(sales, top_n=20),
    }


def sanitize(value):
    """Replace NaN/inf with JSON-safe values."""
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
    return value


def main() -> None:
    if not INPUT_FILE.exists():
        alt = INPUT_FILE.with_suffix(".csv")
        if alt.exists():
            path = alt
        else:
            print(f"ERROR: could not find {INPUT_FILE} or {alt}", file=sys.stderr)
            sys.exit(1)
    else:
        path = INPUT_FILE

    df = load_dataset(path)
    sales, cancel = clean_dataset(df)
    payload = build_payload(sales, cancel)

    with OUTPUT_FILE.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, default=sanitize, ensure_ascii=False)

    print(f"[done] wrote {OUTPUT_FILE} "
          f"({OUTPUT_FILE.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
