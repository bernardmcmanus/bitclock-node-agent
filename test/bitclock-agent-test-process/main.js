import yargs from 'yargs';

const argv = yargs.parse(process.argv);

function run(cb) {
	setTimeout(cb, argv.timeout);
}

switch (argv.action) {
	case 'exit':
		run(() => process.exit(argv.code));
		break;

	case 'register':
		require('../../lib/register');
		run(() => {
			// eslint-disable-next-line no-console
			console.log(JSON.stringify(require('bitclock').config()));
		});
		break;

	default:
		run(() => (
			// eslint-disable-next-line no-console
			console.log(JSON.stringify(argv))
		));
		break;
}
