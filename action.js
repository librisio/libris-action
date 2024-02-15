const core = require('@actions/core');
const github = require('@actions/github');
const libfs = require('fs');
const { Octokit } = require("@octokit/core");
const {Client, Config} = require("./libris-js/libris.js");
const {child_process} = require("./libris-js/libris.js");

// Update a single file.
async function update_file(branch, path, data) {

    // Vars.
    const token = process.env.GITHUB_TOKEN;
    const octokit = new Octokit({ auth: token });
    const context = github.context;
    if (branch === "") {
        branch = context.ref.replace('refs/heads/', '');
    }
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    console.log(`Saving documentation to "${branch}:${path}".`);

    // Convert content to Base64
    const content = Buffer.from(data).toString('base64');

    // Check if branch exists, create if it does not
    try {
        await my_octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/{ref}', {
            owner,
            repo,
            ref: branch,
        });
    } catch (error) {
        if (error.status === 404) {
            // If branch does not exist, create it from the default branch (main)
            const { data } = await my_octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/main', {
                owner,
                repo,
            });
            await my_octokit.request('POST /repos/{owner}/{repo}/git/refs', {
                owner,
                repo,
                ref: `refs/heads/${branch}`,
                sha: data.object.sha,
            });
        } else {
            throw error;
        }
    }

    // Check if the file exists and get its SHA if it does
    let sha;
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path,
            ref: branch,
        });
        sha = data.sha;
    } catch (error) {
        if (error.status !== 404) {
            throw error; // Rethrow if error is not because the file doesn't exist
        }
        // File does not exist, proceed without sha
    }

    // Create or update the file
    try {
        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path,
            message: "Updated auto-generated documentation",
            content,
            sha, // If undefined, a new file will be created
            branch,
        });
    } catch (error) {
        console.error(`Failed to update repository path "${path}".`)
        throw error;
    }
}

// Generate documentation using the API.
async function generate_docs(config_path, output_path) {
    console.log("Generating documentation.");

    // Load the config.
    const full_config_path = `${process.env.GITHUB_WORKSPACE}/${config_path}`;
    if (!libfs.existsSync(full_config_path)) {
        let dir_dump = "";
        libfs.readdirSync(process.cwd()).forEach((path) => {
            dir_dump += ` - ${path}\n`
        })
        dir_dump = dir_dump.substr(0, dir_dump.length - 1)
        throw new Error(`Defined config path "${config_path}" does not exist (full path ${full_config_path}). Current working directory: \n${dir_dump}`);
    }
    const config = Config.load(full_config_path);

    // Reset the output path.
    config.output = null;

    // Initialize client.
    const client = new Client({
        api_key: process.env.LIBRIS_API_KEY,
        config,
    });

    // Generate the documentation.
    const response = await client.generate(true);

    // Return the html.
    return response.html;
}

// Main functino.
async function main() {
    try {
        
        // Get args.
        const config_path = core.getInput("config");
        if (typeof config_path !== "string") {
            throw new Error('Define input parameter "config" of type "string".');
        }
        let output_path = core.getInput("output");
        if (typeof output_path !== "string") {
            throw new Error('Define input parameter "output" of type "string".');
        }
        let branch = core.getInput("branch");
        if (typeof branch !== "string") {
            throw new Error('Define input parameter "branch" of type "branch".');
        }

        // Check env.
        if (typeof process.env.GITHUB_TOKEN !== "string" || process.env.GITHUB_TOKEN === "") {
            throw new Error('Define environment variable "GITHUB_TOKEN" using your repository secrets.');
        }
        if (typeof process.env.LIBRIS_API_KEY !== "string" || process.env.LIBRIS_API_KEY === "") {
            throw new Error('Define environment variable "LIBRIS_API_KEY" using your repository secrets.');
        }

        // Clean output path.
        output_path = output_path.replaceAll("//", "/");
        let c;
        while (output_path.length > 0 && ((c = output_path.charAt(0)) === "." || c == "/")) {
            output_path = output_path.substr(1);
        }

        // Generate documentation.
        const html = await generate_docs(config_path, output_path);

        // Save the file.
        await update_file(branch, output_path, html);
    }

    // Cacth error.
    catch (error) {
        console.error(error);
        core.setFailed(error.message != null ? error.message : `Action failed with error: ${error}`)
    }
}

main();
