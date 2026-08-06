// Test the extractAgentInfo function
function extractAgentInfo(args) {
	if (!args || typeof args !== "object") return null;

	const params = args;

	// Single mode: { agent, task }
	if (typeof params.agent === "string" && typeof params.task === "string") {
		return { agentName: params.agent, task: params.task };
	}

	// Parallel mode: { tasks: [{ agent, task }] }
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		const firstTask = params.tasks[0];
		if (
			firstTask &&
			typeof firstTask === "object" &&
			typeof firstTask.agent === "string"
		) {
			const count = params.tasks.length;
			return {
				agentName: "parallel",
				task: `${count} task${count > 1 ? "s" : ""} in parallel`,
			};
		}
	}

	// Chain mode: { chain: [{ agent, task }] }
	if (Array.isArray(params.chain) && params.chain.length > 0) {
		const firstTask = params.chain[0];
		if (
			firstTask &&
			typeof firstTask === "object" &&
			typeof firstTask.agent === "string"
		) {
			const count = params.chain.length;
			return {
				agentName: "chain",
				task: `${count} step${count > 1 ? "s" : ""} chained`,
			};
		}
	}

	return null;
}

// Test cases
const tests = [
	{ agent: "scout", task: "find all TypeScript files" },
	{ tasks: [{ agent: "scout", task: "find .ts" }, { agent: "planner", task: "plan" }] },
	{ chain: [{ agent: "scout", task: "recon" }, { agent: "planner", task: "plan" }] },
	{ invalid: "data" },
	null,
];

console.log("Test results:");
tests.forEach((test, i) => {
	const result = extractAgentInfo(test);
	console.log(`Test ${i + 1}:`, JSON.stringify(test), "=>", JSON.stringify(result));
});
