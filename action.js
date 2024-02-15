const core = require('@actions/core');
const github = require('@actions/github');
const libfs = require('fs');
const { Octokit } = require("@octokit/core");
const {Client, Config} = require("./libris-js/libris.js");

// Update a single file.
async function update_file(path, data) {

    // Vars.
    const token = process.env.GITHUB_TOKEN;
    const octokit = new Octokit({ auth: token });
    const context = github.context;
    const branch = context.ref.replace('refs/heads/', '');
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    // Convert content to Base64
    const content = Buffer.from(data).toString('base64');

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
    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        message,
        content,
        sha, // If undefined, a new file will be created
        branch,
    });
}

// Generate documentation using the API.
async function generate_docs(config_path, output_path) {

    // Load the config.
    const full_config_path = `${process.env.GITHUB_WORKSPACE}/${config_path}`;
    if (!libfs.fileExistsSync(full_config_path)) {
        throw new Error(`Defined config path "${config_path}" does not exist (full path ${full_config_path}).`);
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
    const response = await client.generate_docs(true);

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
        const output_path = core.getInput("output");
        if (typeof output_path !== "string") {
            throw new Error('Define input parameter "output" of type "string".');
        }

        // Check env.
        if (typeof process.env.GITHUB_TOKEN !== "string" || process.env.GITHUB_TOKEN === "") {
            throw new Error('Define environment variable "GITHUB_TOKEN" using your repository secrets.');
        }
        if (typeof process.env.LIBRIS_API_KEY !== "string" || process.env.LIBRIS_API_KEY === "") {
            throw new Error('Define environment variable "LIBRIS_API_KEY" using your repository secrets.');
        }

        // Generate documentation.
        const html = await generate_docs(config_path, output_path);

        // Save the file.
        await update_file(output_path, html);
    }

    // Cacth error.
    catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

main();
