function askBody(ask) {
    const questions = ask && Array.isArray(ask.questions) ? ask.questions : [];
    const first = questions.length > 0 ? questions[0] : null;
    const question = String(first && first.question || "").replace(/\s+/gu, " ").trim();
    let body = question === "" ? "Needs your input" : "Needs your input · " + question;
    const remaining = Math.max(0, questions.length - 1);
    if (remaining > 0) body += " (+" + remaining + " more)";
    return body;
}
