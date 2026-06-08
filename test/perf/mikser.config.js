// Minimal config for the render-pipeline perf test. Only the plugins
// the render path actually needs:
//   - documents: file → entity for the corpus under documents/
//   - front-matter + yaml: extract the YAML header from each .html file
//   - layouts: match every document to layouts/post.hbs via auto-layout
//   - render-hbs: the renderer
//
// NO vector (OpenAI embedding API would dominate wall-clock),
// NO postprocessors (post-mjml/post-pdf would dominate),
// NO decap/api/schemas (not exercising those paths here).
//
// Result: time spent here is pure mikser engine + handlebars render.
// That's what we want to advertise — "10k entities, X seconds."

export default async () => ({
    plugins: [
        'documents',
        'front-matter',
        'yaml',
        'layouts',
        'render-hbs',
    ],
    documents: {
        documentsFolder: 'documents',
    },
    layouts: {
        autoLayouts: true,
    },
})
