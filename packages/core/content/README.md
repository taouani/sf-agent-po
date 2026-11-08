# Domain content

The agents' domain knowledge lives here as Markdown, so an SA or PO can review and change it
without touching code. The tests check every file when they run.

- `industries/<id>.md`: one industry template per file. The front matter gives the `id` (the same
  as the file name), the `name` shown to the model, and `aliases`, other names users type
  (`[banking, fsi]`). Then come exactly these sections, each as `## ` headings:
  `Salesforce products to consider`, `Data model`, `Regulation and compliance`,
  `Typical integrations`, `Watch for`. Each section is one paragraph, without headings or blank
  lines, because the agents receive it as one bullet.
- `agents/<id>.md`: the agents' roles and practices, used as written.
- `templates/<id>.md`: document templates (high-level and detailed design), used as written.
- `checks/<language>.md`: the word lists the quality checks use when a context's output language
  is that one (`en.md`, `fr.md`). The front matter gives the `language` code (the same as the file
  name) and its `name`. Then come exactly these sections, each a list of `- ` entries, lowercase,
  one word or phrase each: `Vague words` (not testable), `Generic personas`, `Articles` (allowed
  before a generic persona), `Compliance terms`, `Joining words` (that join two needs) and
  `Common words` (to tell the language of a text). An entry ending in `*` also matches the
  words it starts. Inputs are checked for compliance terms in every language.

Product and object names change between Salesforce releases and licences, so the agents are told
to confirm them against the org's metadata before relying on them.

A team can keep its own content in another folder with the same layout. A file there replaces
the built-in one with the same id, and new ids are added. Two industries cannot share an alias:
to reuse a built-in alias (for example `fashion`), also add your own copy of the built-in
industry (`luxury.md`) without it.
