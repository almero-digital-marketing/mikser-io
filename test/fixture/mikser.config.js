export default async ({ options }) => ({
	plugins: [
		'documents',
		'front-matter',
		'yaml',
		'layouts',
		'files',
        'resources',
		'assets',
		'render-hbs',
		'render-liquid',
		'render-eta',
		'render-href',
		'render-resource',
		'render-asset',
		'render-markdown',
		'post-pdf',
		'post-mjml',
	],
    resources: {
        outputFolder: 'public',
		libraries: {
			images: {
				url: 'https://placehold.co/',
			},
            videos: {
                url: 'https://lorem.video/'
            }
		}
	},
    assets: {
        outputFolder: 'public',
        presets: {
            'small-image': [
                '/files/images/*.jpg', 
                '/resources/**/*.jpg', 
            ],
            'small-video': [
                '/files/videos/*.mp4', 
                '/resources/**/*.mp4', 
            ]
        }
    },
    layouts: {
        autoLayouts: true,
    }
})
