import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html', // SPA mode - all routes serve index.html
			precompress: false,
			strict: true
		}),
		alias: {
			'$components': 'src/lib/components',
			'$stores': 'src/lib/stores',
			'$utils': 'src/lib/utils'
		}
	}
};

export default config;
