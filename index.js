require('dotenv').config();

const { log } = console;

// console.clear();

const os = require('os');
const fs = require('fs');
const Docker = require('dockerode');
const Stream = require('stream');

let dockerPath = '/var/run/docker.sock';

log(`> Starting Controvos client...`);

// Check ram
log(`> Checking resources...`);
const clientRAM = Math.floor(os.totalmem() / 1024 / 1024);
const clientCPU = os.cpus().length;
log(` | Client RAM: ${clientRAM} MB`);
log(` | Client CPU: ${clientCPU} vCPU`);

if (process.arch == 'x64') {
    cpu = 'x86';
} else if (process.arch == 'arm' || process.arch == 'arm64') {
    cpu = 'arm';
} else {
    log(` | Unsupported cpu ${process.arch}`);
    process.exit(1);
}
log(` | Client arch: ${cpu}`);

// Get code
log(`> Getting code...`);
const code = process.env.CODE;
log(` | Connect code: ${code}`);

// Check docker
log(`> Checking if docker is installed...`);
if (!fs.existsSync(dockerPath)) {
    log(` | Docker not found! ${dockerPath}`);
    process.exit(1);
}
log(` | Found docker at ${dockerPath}`);
const docker = new Docker({ socketPath: dockerPath });
log(` | Created docker client!`);

log(`> Connecting to API...`);
main();

let cpuAvailable = 0;
let ramAvailable = 0;

async function main() {
    const ok = await fetch(`${process.env.API}/connect?code=${code}&cpu=${cpu}&cpucount=${clientCPU}&ram=${clientRAM}`);

    if (ok.ok == false) {
        log(` | Failed to connect: ${(await ok.json()).error}`);
        process.exit(1);
    }

    const connectBody = await ok.json();
    cpuAvailable = connectBody.cpu;
    ramAvailable = connectBody.ram;

    log(` |  Connected!`);

    setInterval(() => {
        try {
            getJob();
        } catch (e) {
            console.log(`Failed to get job!`, e);
        }
    }, 1000 * 60 * 1);
    try {
        getJob();
    } catch (e) {
        console.log(`Failed to get job!`, e);
    }

    ping();
}

async function ping() {
    // console.log(`> Sending heartbeat...`);
    await fetch(`${process.env.API}/ping?code=${code}`);
}

setInterval(() => {
    ping();
}, 1000 * 60 * 1);

async function getJob() {
    try {
        log(`> Getting job...`);

        console.log(`> available - ${cpuAvailable} vCPU - ${ramAvailable} MB`);

        if (cpuAvailable <= 0 || ramAvailable <= 0) return console.log(`> No resources available.`);

        var jobs = await fetch(`${process.env.API}/jobs/get?code=${code}&cpu=${cpuAvailable}&ram=${ramAvailable}`).then(r => r.json());

        if (jobs.found == false) {
            return log(` | No job found :(`);
        }

        for (let i = 0; i < jobs.jobs.length; i++) {
            job = jobs.jobs[i];

            console.log(` | Found job ${job.ID}`);

            processJob(job).then(() => {
                log(`> Job finished: ${job.ID}`);
            }).catch(e => {
                console.log('ProcessJob.func failed', e)
                errorJob(job.ID, String(e));
            });

        }
    } catch (e) {
        console.log('failed getting job...', e)
    }
}

async function errorJob(id, error) {
    if (!error || error == 'null') console.warn(`No error message! ${id}`);
    try {
        await fetch(`${process.env.API}/jobs/finish?code=${code}&id=${id}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                ok: false,
                exitCode: -500,
                error: String(error)
            })
        }).then(r => r.json());

        log(` | Job failed: ${String(error)}`);
    } catch (e) {
        log(` | Failed to send error! ${String(e)}`, e);
    }
}

async function processJob(job) {

    const { ramRequired, cpuRequired, timeLimit, ID } = job;

    cpuAvailable = cpuAvailable - cpuRequired;
    ramAvailable = ramAvailable - ramRequired;

    try {
        let outputLog;
        outputLog = '[System] Building image...\n';

        var startPull = Date.now() / 1000;
        let image;
        try {
            image = await buildImage(job);
        } catch (error) {

            cpuAvailable = cpuAvailable + cpuRequired;
            ramAvailable = ramAvailable + ramRequired;

            errorJob(job.ID, 'Failed to build image');
            console.log('Failed to build image', error);
        }
        var endPull = Date.now() / 1000;
        outputLog += `> Built in ${Math.ceil(endPull - startPull)} seconds\n\nOUTPUT:\n`;

        log(` | Image built!`);

        const output = new Stream.Writable({
            write: (data) => {
                data = String(data);
                outputLog += data;
                return data;
            }
        });

        let runPath = `${__dirname}/cache/${job.ID}.sh`;
        let dataPath = `${__dirname}/cache/${job.ID}.txt`;

        try {
            fs.writeFileSync(runPath, job.command);
            fs.chmodSync(runPath, 777);

            fs.writeFileSync(dataPath, job.data);
            fs.chmodSync(dataPath, 777);

            console.log(`> Wrote container files!`);
        } catch (error) {
            cpuAvailable = cpuAvailable + cpuRequired;
            ramAvailable = ramAvailable + ramRequired;

            console.log(error);

            return errorJob(job.ID, 'Failed writing command');
        }

        let CommandBind = `${__dirname}/cache/${job.ID}.sh:/run.sh`;
        let DataBind = `${__dirname}/cache/${job.ID}.txt:/request.txt`;

        let container;
        // Start the container
        container = await docker.createContainer({
            name: `controvos-${ID}`,
            Image: image,
            HostConfig: {
                AutoRemove: true,

                Memory: ramRequired * 1_048_576,
                CpuQuota: cpuRequired * 100_000,
                CPUPeriod: 100_000,
                CpuShares: 1024,

                Binds: [CommandBind, DataBind]
            }
        });


        if (!container) {
            cpuAvailable = cpuAvailable + cpuRequired;
            ramAvailable = ramAvailable + ramRequired;
            return errorJob(ID, 'Failed to create container');
        }

        // Set a timeout to kill the container if it exceeds the time limit
        const containerTimeout = setTimeout(async () => {
            log(` | Time limit of ${timeLimit} seconds reached, stopping container...`);
            try {
                await container.stop();
            } catch (e) {
                console.log(`> Failed to stop container! ${String(e)}`, e);
                // process.exit(1);
            }
            cpuAvailable = cpuAvailable + cpuRequired;
            ramAvailable = ramAvailable + ramRequired;
            errorJob(ID, `Container exceeded time limit of ${timeLimit} seconds`);
        }, timeLimit * 1000);

        await container.start();
        log(` | Container started!`);

        async function sendLog(outputLog) {
            if (outputLog.length < 1) return; // No new output, skip sending
            try {
                var logRes = await fetch(`${process.env.API}/jobs/log?code=${code}&id=${ID}`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: outputLog
                    })
                }).then(r => r.json());
                console.log(` | Logged: ${logRes.ID}`);
            } catch (e) {
                console.log(`> Failed to send log! ${String(e)}`, e);
                // process.exit(1);
            }
        }

        var logInt = setInterval(async () => {
            // console.log(outputLog);
            await sendLog(outputLog);
            outputLog = '';
        }, 3000);

        try {
            const containerStream = await container.attach({ stream: true, stdout: true, stderr: true, logs: true });
            containerStream.pipe(output);

            containerStream.on('data', (d) => {
                outputLog += String(d);
            });
        } catch (err) {
            cpuAvailable = cpuAvailable + cpuRequired;
            ramAvailable = ramAvailable + ramRequired;

            console.log('Failed to attach to container', err);
            // process.exit(1);
        }

        // Wait for the container to finish
        let exitCode = await container.wait();


        clearTimeout(containerTimeout); // Clear the timeout if the container finishes within the time limit
        clearInterval(logInt); // Clear the timeout if the container finishes

        try {

            await sendLog(outputLog);

        } catch (error) {
            console.log(`> Failed to send container log at finish! ${String(error)}`, error);
            // process.exit(1);
        }

        var isOk = true;
        if (exitCode.StatusCode != 0) isOk = false;

        await fetch(`${process.env.API}/jobs/finish?code=${code}&id=${ID}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                ok: isOk,
                exitCode: exitCode.StatusCode,
                error: `Check logs ^`
            })
        }).then(r => r.json()).catch((e) => {
            console.log(`> Failed to send container finish! ${String(e)}`, e);
            // process.exit(1);
        });

        cpuAvailable = cpuAvailable + cpuRequired;
        ramAvailable = ramAvailable + ramRequired;

        fs.rmSync(runPath);
        fs.rmSync(dataPath);

        console.log(` | Job ${job.ID} finished! ${exitCode}`);
    } catch (e) {
        console.log(`> Failed to process job! ${String(e)}`);
        errorJob(job.ID, String(e));
    }

}


async function buildImage(job) {

    var path = `./cache/build/${job.ID}`;
    fs.mkdirSync(path, { recursive: true });

    var template = fs.readFileSync(`./DockerTemplate.txt`, 'utf-8');

    let BaseImage;
    let entrypoint;

    switch (job.baseImage) {
        case 'debian-12':
            BaseImage = 'debian:12';
            entrypoint = 'bash';
            break;
        case 'ubuntu-24':
            BaseImage = 'ubuntu:24.04';
            entrypoint = 'bash';
            break;
        case 'alpine-3.20':
            BaseImage = 'alpine:3.20';
            entrypoint = 'ash';
            break;
        default:
            BaseImage = 'debian:12';
            entrypoint = 'bash';
            break;
    }

    template = template.replace('{{ IMG }}', BaseImage);
    template = template.replace('{{ ENTRY }}', entrypoint);

    fs.writeFileSync(`${path}/Dockerfile`, template);
    fs.writeFileSync(`${path}/install.sh`, job.baseCommand);

    let buildStream = await docker.buildImage({
        context: path,
        src: [`Dockerfile`, `install.sh`]
    }, {
        pull: true,

        memory: job.ramRequired * 1_048_576,
        CpuQuota: job.cpuRequired * 100_000,
        CPUPeriod: 100_000,
        CpuShares: 1024,

        t: `controvos-${job.functionID}:latest`
    });

    await new Promise((resolve, reject) => {
        docker.modem.followProgress(buildStream, (err, res) => {
            if (err) {
                console.log(`> Failed to build image! ${String(err)}`, err);
                errorJob(job.ID, err);
                return reject(err);
            }
            console.log(res);
            resolve(res);
        }, (res) => {

            if (res.error) {
                errorJob(job.ID, res.error);
                return reject(res.error);
            }

            if (res.stream) {
                console.log(` | Str: ${res.stream}`);
            }
            if (res.status && res.progress) {
                console.log(` | Prog: ${res.status} ${res.progress}`);
            } else if (res.status) {
                console.log(` | Stat: ${res.status}`);
            }

            // console.log(res);

        });
    });

    log(` | Image built: controvos-${job.functionID}:latest`);

    fs.rmSync(`${path}/Dockerfile`);
    fs.rmSync(`${path}/install.sh`);
    fs.rmdirSync(path);

    return `controvos-${job.functionID}:latest`;
}