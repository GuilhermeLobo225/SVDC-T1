"""
clean_energy_data.py
--------------------
Script de limpeza e preparação do dataset 'owid-energy-data.csv' (Our World in Data)
para alimentar visualizações interativas em D3.js.

Pipeline:
  1. Cria a coluna `entity_type` (Country vs Region) com base no `iso_code`.
  2. Remove linhas cujo `country` traz sufixos de fontes externas
     ((Ember), (EI), (EIA), (Shift)) — duplicam regiões e estão incompletas.
  3. Filtra para year >= 1990 (corta o ruído de anos sem dados modernos).
  4. Seleciona um subconjunto de colunas relevantes.
  5. Divide em dois CSVs: países_limpos.csv e regiões_limpas.csv.
"""

import pandas as pd

# Caminhos de input/output. Ajusta se executares fora do ambiente do Claude.
INPUT_PATH = "owid-energy-data.csv"
OUTPUT_COUNTRIES = "países_limpos.csv"
OUTPUT_REGIONS = "regiões_limpas.csv"

# ---------------------------------------------------------------------------
# 0. Carregar o CSV original
# ---------------------------------------------------------------------------
df = pd.read_csv(INPUT_PATH)
print(f"[0] Dataset original: {df.shape[0]:,} linhas x {df.shape[1]} colunas")

# ---------------------------------------------------------------------------
# 1. Criar a coluna entity_type
# ---------------------------------------------------------------------------
# A OWID atribui iso_code apenas a países soberanos. Agregados (continentes, blocos económicos, "World") ficam com iso_code nulo — isso é o sinal que usamos para distinguir.
df["entity_type"] = df["iso_code"].isna().map({True: "Region", False: "Country"})
print(f"[1] entity_type criado: "
      f"{(df['entity_type'] == 'Country').sum():,} Country | "
      f"{(df['entity_type'] == 'Region').sum():,} Region")

# ---------------------------------------------------------------------------
# 2. Remover entidades com sufixos de fontes externas
# ---------------------------------------------------------------------------
# Linhas tipo "Africa (EI)" ou "ASEAN (Ember)" são versões alternativas das mesmas regiões, calculadas por agências diferentes. Têm cobertura incompleta (faltam população e GDP) e duplicam o que já existe nas linhas "limpas".
suffixes = ["(Ember)", "(EI)", "(EIA)", "(Shift)"]
# Cria um padrão regex à la "(Ember)|(EI)|(EIA)|(Shift)", escapando os parênteses.
pattern = "|".join(map(pd.io.common.re.escape, suffixes))
mask_suffix = df["country"].str.contains(pattern, regex=True, na=False)
print(f"[2] A remover {mask_suffix.sum():,} linhas com sufixos de fonte")
df = df.loc[~mask_suffix].copy()

# ---------------------------------------------------------------------------
# 3. Filtrar anos >= 1990
# ---------------------------------------------------------------------------
# Pré-1990 a maioria das séries de renováveis modernas (solar, eólica) ainda não existia ou não era reportada — ficaria coluna a coluna cheia de NaN.
df = df.loc[df["year"] >= 1990].copy()
print(f"[3] Após filtro year >= 1990: {df.shape[0]:,} linhas")

# ---------------------------------------------------------------------------
# 4. Selecionar subconjunto de colunas relevantes para D3.js
# ---------------------------------------------------------------------------
# Critério: identificadores + demografia + mix energético principal + emissões.
relevant_columns = [
    # --- Identificação ---
    "country",                       # nome da entidade
    "iso_code",                      # ISO-3 (útil para mapas em D3)
    "entity_type",                   # Country | Region
    "year",                          # ano

    # --- Demografia / economia ---
    "population",                    # população total
    "gdp",                           # PIB (USD constantes)

    # --- Consumo total ---
    "primary_energy_consumption",    # consumo total de energia primária (TWh)
    "energy_per_capita",             # energia per capita (kWh)

    # --- Mix energético: shares (%) ---
    "fossil_share_energy",           # % fósseis no mix
    "renewables_share_energy",       # % renováveis no mix
    "low_carbon_share_energy",       # % baixo carbono (renováveis + nuclear)
    "nuclear_share_energy",          # % nuclear
    "solar_share_energy",            # % solar
    "wind_share_energy",             # % eólica
    "hydro_share_energy",            # % hídrica

    # --- Externalidade climática ---
    "greenhouse_gas_emissions",      # emissões GEE do setor energético (Mt CO2e)
]
df = df[relevant_columns]
print(f"[4] Colunas selecionadas: {len(relevant_columns)}")

# ---------------------------------------------------------------------------
# 5. Dividir em countries / regions e exportar
# ---------------------------------------------------------------------------
df_countries = df.loc[df["entity_type"] == "Country"].copy()
df_regions = df.loc[df["entity_type"] == "Region"].copy()

# index=False: o D3 não precisa do índice do pandas
df_countries.to_csv(OUTPUT_COUNTRIES, index=False)
df_regions.to_csv(OUTPUT_REGIONS, index=False)

print(f"[5] Exportado:")
print(f"    {OUTPUT_COUNTRIES}: {df_countries.shape[0]:,} linhas")
print(f"    {OUTPUT_REGIONS}:   {df_regions.shape[0]:,} linhas")
