# Changelog

## 0.1.3

- Added a default-off setting for sending automatically retrieved literature excerpts to cloud models.
- Preserved article-level license, license URL, copyright, and citation metadata through research source APIs and modeling export responses; unknown article licenses remain explicit.
- Modeling CSV exports remain limited to `time` and `biomass` values and include a separate source citation in the API response.
- Improved Europe PMC license metadata extraction from core records and JATS article permissions.
