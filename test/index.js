import fs from 'fs';
import { spawnSync } from 'child_process';
import { AssertionError } from 'assert';
import glob from 'glob';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import ps from 'current-processes';
import yaml from 'js-yaml';
import Bluebird from 'bluebird';
import bitclock from 'bitclock';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import spawnRequire from 'spawn-require';
import uuid from 'uuid';
import difference from 'lodash/difference';

import getConfig from '../lib/config';
import agent from '../lib/agent';
import * as helpers from '../lib/helpers';
import * as os from '../lib/instrumentation/os';

chai.use(chaiAsPromised);

Bluebird.promisifyAll(fs);

const noop = () => undefined;
const configFile = '.bitclockrc';
const testProcessPath = 'test/bitclock-agent-test-process';
const testConfig = Object.freeze({
	...bitclock.config(),
	reportingEndpoint: 'http://localhost:3000',
	reportingInterval: 1,
	bucket: uuid.v4(),
	token: Math.random().toString(16),
	instrument: true,
	silent: true
});

process.env.BITCLOCK_TEST_CONFIG = JSON.stringify(testConfig);

function spawnSyncProcess(cmd, args, cb = noop) {
	const unwrap = spawnRequire(['babel-register']);
	const filteredArgs = args.filter((value, i) => (
		// check lastIndexOf to allow entrypoint to be overridden
		args.lastIndexOf(value) === i
	));
	const result = spawnSync(cmd, filteredArgs);
	unwrap();
	if (result.stderr.length) {
		throw new Error(result.stderr.toString());
	}
	try {
		cb(result);
	} catch (err) {
		/* eslint-disable no-console */
		console.log(result.stdout.toString());
		console.log(result.stderr.toString());
		/* eslint-enable no-console */
		throw err;
	}
	return result;
}

function spawnTestProcess(args = [], cb) {
	return spawnSyncProcess('node', [
		'--require',
		'./test/mock-server',
		'lib',
		`--config=${configFile}`,
		testProcessPath,
		...args
	], cb);
}

function writeConfig({ values = {}, name = configFile, ext = '' } = {}) {
	let data;
	const configObject = { ...testConfig, ...values };
	switch (ext) {
		case '.js':
			data = `module.exports=${JSON.stringify(configObject, null, 2)};`;
			break;
		case '.json':
			data = JSON.stringify(configObject, null, 2);
			break;
		case '.yml':
		case '.yaml':
			data = yaml.safeDump(configObject);
			break;
		default:
			data = Object
				.keys(configObject)
				.map(key => `${key}="${configObject[key]}"`)
				.join('\n');
			break;
	}
	return fs.writeFileAsync(`${name}${ext}`, data);
}

function cleanConfig() {
	return Bluebird
		.fromCallback(cb => glob(`${configFile}{,*}`, { dot: true }, cb))
		.map(fname => fs.unlinkAsync(fname));
}

function getReportingCallCount() {
	const output = fs.readFileSync(`.test_output/${testConfig.bucket}`, 'utf-8');
	return output.split('\n').length;
}

function pgrepNode() {
	return Bluebird
		.fromCallback(cb => ps.get(cb))
		.then(results => (
			results
				.filter(({ name }) => /node/i.test(name))
				.map(({ pid }) => Number(pid))
		));
}

function recursiveCheck(fn, delay = 200, max = 10, attempts = 0) {
	return Bluebird
		.try(fn)
		.catch((err) => {
			if (attempts >= max) {
				throw err;
			}
			return Bluebird
				.delay(delay)
				.then(() => (
					recursiveCheck(fn, delay, max, attempts + 1)
				));
		});
}

before(cb => rimraf('.test_output/*', cb));

before(() => mkdirp('.test_output'));

after(() => cleanConfig());

describe('config', () => {
	['', '.js', '.json', '.yml', '.yaml'].forEach((ext) => {
		it(`should read config from ${configFile}${ext}`, () => (
			writeConfig({ ext, values: { ext } })
				.then(() => getConfig())
				.then((config) => {
					expect(config).to.deep.equal({ ...testConfig, ext });
				})
				.then(() => cleanConfig())
		));
	});

	it('should accept a relative path to a non-standard named config file', () => (
		writeConfig({ ext: '.other' })
			.then(() => getConfig(`${configFile}.other`))
			.then((config) => {
				expect(config).to.deep.equal(testConfig);
			})
			.then(() => cleanConfig())
	));

	it('should extend other config files', () => (
		cleanConfig()
			.then(() => Bluebird.all([
				writeConfig({
					ext: '.yaml',
					name: `${configFile}-base`,
					values: {
						base: true,
						foo: 'bar'
					}
				}),
				writeConfig({
					ext: '.json',
					name: `${configFile}-extended`,
					values: {
						extends: `${configFile}-base.yaml`,
						base: false
					}
				})
			]))
			.then(() => getConfig(`${configFile}-extended.json`))
			.then((config) => {
				expect(config).to.include({
					extends: `${configFile}-base.yaml`,
					base: false,
					foo: 'bar'
				});
			})
	));

	it('should disable the agent if an error occurs', () => (
		cleanConfig()
			.then(() => getConfig())
			.then((config) => {
				expect(config).to.deep.equal({ instrument: false });
			})
	));
});

describe('instrumentation', () => {
	describe('os', () => {
		describe('cpu', () => {
			it('should reject the promise when pid is missing', () => (
				expect(os.cpu()).to.be.rejectedWith(AssertionError, 'Missing pid')
			));

			it('should monitor cpu load', () => (
				os.cpu(process.pid).then((result) => {
					expect(result.system).to.be.an('object');
					expect(result.system.count).to.be.a('number');
					expect(result.system.load['1m']).to.be.a('number');
					expect(result.system.load['5m']).to.be.a('number');
					expect(result.system.load['15m']).to.be.a('number');
					expect(result.process).to.be.an('object');
					expect(result.process.utilization).to.be.a('number');
				})
			));
		});

		describe('memory', () => {
			it('should reject the promise when pid is missing', () => (
				expect(os.memory()).to.be.rejectedWith(AssertionError, 'Missing pid')
			));

			it('should monitor memory usage', () => (
				os.memory(process.pid).then((result) => {
					expect(result.system).to.be.an('object');
					expect(result.system.total).to.be.a('number');
					expect(result.system.free).to.be.a('number');
					expect(result.system.utilization).to.be.a('number');
					expect(result.process).to.be.an('object');
					expect(result.process.bytes).to.be.a('number');
					expect(result.process.utilization).to.be.a('number');
				})
			));
		});
	});
});

describe('helpers', () => {
	describe('isTrueNumber', () => {
		it('should return true if value can be coerced to a number, false otherwise', () => {
			expect(helpers.isTrueNumber(0)).to.equal(true);
			expect(helpers.isTrueNumber('5')).to.equal(true);
			expect(helpers.isTrueNumber('0.5')).to.equal(true);
			expect(helpers.isTrueNumber('.5')).to.equal(true);
			expect(helpers.isTrueNumber('05')).to.equal(true);
			expect(helpers.isTrueNumber('0.5.0')).to.equal(false);
			expect(helpers.isTrueNumber('')).to.equal(false);
			expect(helpers.isTrueNumber(NaN)).to.equal(false);
		});
	});

	describe('mapValues', () => {
		it('should return a new object with mapped values', () => {
			const initial = { a: 1, b: 2, c: 3 };
			const mapped = helpers.mapValues(initial, v => v * 2);
			expect(mapped).to.deep.equal({ a: 2, b: 4, c: 6 });
		});
	});

	describe('toPrimitive', () => {
		it('should parse strings to primitive values', () => {
			const initial = {
				a: 1,
				b: '0',
				c: true,
				d: 'false',
				e: { f: ['null', 'undefined'] }
			};
			const parsed = helpers.toPrimitive(initial);
			expect(parsed).to.deep.equal({
				a: 1,
				b: 0,
				c: true,
				d: false,
				e: { f: [null, undefined] }
			});
		});
	});

	describe('round', () => {
		it('should round a number to precision', () => {
			[undefined, 1, 2, 3, 4].forEach((i) => {
				const n = 1e6 * Math.PI;
				expect(
					helpers.round(n, i).toString().split('.')[1] || ''
				)
				.to.have.length(i || 0);
			});
		});
	});

	describe('flatten', () => {
		const fn = () => {};
		const sym = Symbol('symbol');

		const testObject = {
			a: {
				b: {
					c: [{
						d: null,
						i: [[[]]],
						j: 'this is a longer string'
					}, fn, sym]
				}
			},
			e: null,
			f: [{ g: ['h', null, 1, []] }]
		};

		const expected = {
			'a.b.c.0.d': null,
			'a.b.c.0.j': 'this is a longer string',
			'a.b.c.1': fn,
			'a.b.c.2': sym,
			'e': null,
			'f.0.g.0': 'h',
			'f.0.g.1': null,
			'f.0.g.2': 1
		};

		it('should flatten a nested object', () => {
			expect(helpers.flatten(testObject)).to.deep.equal(expected);
		});

		it('should gracefully handle non-object values', () => {
			expect(helpers.flatten()).to.deep.equal({ '': undefined });
			expect(helpers.flatten(null)).to.deep.equal({ '': null });
			expect(helpers.flatten(false)).to.deep.equal({ '': false });
			expect(helpers.flatten(100000)).to.deep.equal({ '': 100000 });
			expect(helpers.flatten(Infinity)).to.deep.equal({ '': Infinity });
		});
	});
});

describe('bitclock agent', () => {
	before(() => writeConfig());

	after(() => cleanConfig());

	afterEach(cb => rimraf('.test_output/*', cb));

	describe('spawn', () => {
		it('should read config from the config file at startup', () => {
			agent({ config: configFile });
			expect(bitclock.config()).to.deep.equal(testConfig);
		});

		it('should spawn a child process with the correct arguments', () => {
			const timeout = 1000;
			spawnTestProcess(['--timeout', timeout], ({ stdout, status }) => {
				const childArgs = JSON.parse(stdout.toString());
				expect(childArgs.timeout).to.equal(timeout);
				expect(status).to.equal(0);
				expect(getReportingCallCount()).to.be.gte(2);
			});
		});

		it('should remove references to the node binary from child args', () => {
			const spawnArgs = ['node', testProcessPath, '--foo=bar'];
			spawnTestProcess(spawnArgs, ({ stdout }) => {
				const childArgs = JSON.parse(stdout.toString());
				expect(childArgs._).to.not.include('node');
			});
		});

		it('should NOT remove references to other binaries from child args', () => {
			const spawnArgs = ['nodemon', testProcessPath];
			expect(() => spawnTestProcess(spawnArgs)).to.throw(/cannot find.+nodemon/i);
		});

		it('should exit with the same code as the child process', () => {
			spawnTestProcess(['--action=exit', '--code=10'], ({ status }) => {
				expect(status).to.equal(10);
			});
		});
	});

	describe('register', () => {
		it('should run with the register hook', () => {
			const configValue = Math.random().toString(16);
			return writeConfig({ values: { configValue } }).then(() => {
				spawnSyncProcess('node', [
					'--require',
					'./test/mock-server',
					testProcessPath,
					'--action=register',
					'--timeout=4000',
					`--configValue=${configValue}`
				], ({ stdout }) => {
					const finalConfig = JSON.parse(stdout.toString());
					expect(finalConfig.configValue).to.equal(configValue);
					expect(getReportingCallCount()).to.be.gte(2);
				});
			});
		});

		it('should not leave orphaned child processes if the parent process exits', () => (
			writeConfig()
				.then(() => pgrepNode())
				.tap((existingPids) => {
					// make sure the test is valid
					expect(existingPids).to.have.length.gte(1);
				})
				.then((existingPids) => {
					const { stdout } = spawnSyncProcess('node', [
						'--require',
						'./test/mock-server',
						testProcessPath,
						'--action=register/orphan'
					]);
					const { pid } = JSON.parse(stdout.toString());
					return pgrepNode().then((runningPids) => {
						// make sure the test process is no longer running
						expect(runningPids).to.not.include(pid);
						return existingPids;
					});
				})
				.then(existingPids => (
					// wait for the reporting process to exit
					recursiveCheck(() => (
						pgrepNode().then((runningPids) => {
							expect(difference(runningPids, existingPids)).to.have.length(0);
						})
					), 1000)
				))
		));
	});
});
