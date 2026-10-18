# Changelog

## 2026-10-18

- Render saved assistant answers as Markdown with GFM tables, headings, lists and source links while retaining the original values and citations.
- Prioritize explicitly named evidence documents over generic keyword matches.
- Decode XML entities and remove markup from public-literature titles and abstracts.
- Add collapsible research profiles, separate abstract/full-text reading and a wider conversation area for scientific tables.
- Stabilize the existing timeout regression test by awaiting child-process cleanup after the timeout status is published.
- Validation: production build and TypeScript check passed; all 177 tests across 22 files passed.


## 0.1.3

- Added a default-off setting for sending automatically retrieved literature excerpts to cloud models.
- Preserved article-level license, license URL, copyright, and citation metadata through research source APIs and modeling export responses; unknown article licenses remain explicit.
- Modeling CSV exports remain limited to `time` and `biomass` values and include a separate source citation in the API response.
- Improved Europe PMC license metadata extraction from core records and JATS article permissions.
