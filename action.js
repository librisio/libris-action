/*
 * @author: Libris Inc.
 * @copyright: © 2024 - 2024 Libris Inc.
 */

// ---------------------------------------------------------
// Imports.

const core = require('@actions/core');
const github = require('@actions/github');
const libfs = require('fs');
const {Octokit} = require("@octokit/core");
const {Client, Config} = require("./libris-js/libris.js");

// ---------------------------------------------------------
// Github action class.
class GithubAction {
    constructor() {

        // Check env.
        if (typeof process.env.GITHUB_TOKEN !== "string" || process.env.GITHUB_TOKEN === "") {
            throw new Error('Define environment variable "GITHUB_TOKEN" using your repository secrets.');
        }
        if (typeof process.env.LIBRIS_API_KEY !== "string" || process.env.LIBRIS_API_KEY === "") {
            throw new Error('Define environment variable "LIBRIS_API_KEY" using your repository secrets.');
        }

        // Argument: config.
        this.config_path = core.getInput("config");
        if (typeof this.config_path !== "string") {
            throw new Error('Define input parameter "config" of type "string".');
        }
        this.abs_config_path = `${process.env.GITHUB_WORKSPACE}/${this.config_path}`;

        // Argument: output.
        this.output_path = core.getInput("output");
        if (typeof this.output_path !== "string") {
            throw new Error('Define input parameter "output" of type "string".');
        }
        this.output_path = this.output_path.replaceAll("//", "/");
        let c;
        while (this.output_path.length > 0 && ((c = this.output_path.charAt(0)) === "." || c == "/")) {
            this.output_path = this.output_path.substr(1);
        }

        // Argument: branch.
        this.branch = core.getInput("branch");
        if (typeof this.branch !== "string") {
            throw new Error('Define input parameter "branch" of type "string".');
        }
        if (this.branch === "") {
            this.branch = github.context.ref.replace('refs/heads/', '');
        }

        // Argument: branch.
        this.orphan = core.getInput("orphan");
        if (typeof this.orphan !== "string" && typeof this.orphan !== "boolean") {
            throw new Error('Define input parameter "orphan" of type "string".');
        }
        if (this.orphan === "true" || this.orphan === "True" || this.orphan === "TRUE" || this.orphan === "1" || this.orphan === 1 || this.orphan === true) {
            this.orphan = true;
        } else {
            this.orphan = false;
        }

        // Attributes.
        this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
        this.owner = github.context.repo.owner;
        this.repo = github.context.repo.repo;
    }

    // Generate documentation using the API.
    async generate_docs() {
        console.log("Generating documentation.");

        // Load the config.
        if (!libfs.existsSync(this.abs_config_path)) {
            let dir_dump = "";
            libfs.readdirSync(process.cwd()).forEach((path) => {
                dir_dump += ` - ${path}\n`
            })
            dir_dump = dir_dump.substr(0, dir_dump.length - 1)
            throw new Error(`Defined config path "${this.config_path}" does not exist (full path ${this.abs_config_path}). Current working directory: \n${dir_dump}`);
        }
        const config = Config.load(this.abs_config_path);

        // Reset the output path.
        config.output = null;

        // Initialize client.
        const client = new Client({
            api_key: process.env.LIBRIS_API_KEY,
            config,
        });

        // Generate the documentation.
        const response = await client.generate(true);
        this.html = response.html;

    }

    // Create a new branch.
    async create_branch() {
        console.log(`Creating branch "${this.branch}".`);
        const {data} = await this.octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/main', {
            owner: this.owner,
            repo: this.repo,
        });
        await this.octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner: this.owner,
            repo: this.repo,
            ref: `refs/heads/${this.branch}`,
            sha: data.object.sha,
        });
    }

    // Create new orphan branch.
    async create_orphan_branch(path, data) {
        console.log(`Creating orphan branch "${this.branch}".`);

        // Create a new tree with the file.
        const { data: tree } = await this.octokit.git.createTree({
            owner: this.owner,
            repo: this.repo,
            tree: [{
                path: this.output_path,
                mode: '100644', // blob (file)
                content: Buffer.from(this.html).toString('base64'),
            }],
        });

        // Create a new commit with no parents (orphan commit).
        const { data: commit } = await this.octokit.git.createCommit({
            owner: this.owner,
            repo: this.repo,
            message: 'Create orphan branch with a single file',
            tree: tree.sha,
            parents: [], // No parents to make it an orphan commit
        });

        // Create a new reference (branch) pointing to the orphan commit.
        await this.octokit.git.createRef({
            owner: this.owner,
            repo: this.repo,
            ref: `refs/heads/${this.branch}`,
            sha: commit.sha,
        });
    }

    // Upload the docs file.
    async upload_docs() {
        console.log(`Uploading the generated documentation to "${this.branch}:${this.output_path}".`);

        // Check if branch exists, create if it does not.
        try {
            await this.octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/{ref}', {
                owner: this.owner,
                repo: this.repo,
                ref: this.branch,
            });
        } catch (error) {
            if (error.status === 404) {
                if (this.orphan) {
                    await this.create_orphan_branch()
                    return ;
                } else {
                    await this.create_branch();
                }
            } else {
                throw error;
            }
        }

        // Check if the file exists and get its SHA if it does.
        let sha;
        try {
            const {data} = await this.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.owner,
                repo: this.repo,
                path: this.output_path,
                ref: this.branch,
            });
            sha = data.sha;
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
        }

        // Create or update the file.
        try {
            await this.octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
                owner: this.owner,
                repo: this.repo,
                path: this.output_path,
                message: "Updated auto-generated documentation",
                content: Buffer.from(this.html).toString('base64'),
                sha, // if undefined, a new file will be created.
                branch: this.branch,
            });
        } catch (error) {
            console.error(`Failed to update repository path "${this.output_path}".`)
            throw error;
        }
    }

    // Start the action.
    static async start() {
        try {
            console.log(`Starting GitHub Action.`);

            // Initialize action.
            const action = new Action();

            // Generate docs.
            await action.generate_docs();

            // Upload the docs.
            await action.upload_docs();
        }

        // Cacth error.
        catch (error) {
            console.error(error);
            core.setFailed(error.message != null ? error.message : `Action failed with error: ${error}`)
        }
    }
}

// ---------------------------------------------------------
// Start.

GithubAction.start();