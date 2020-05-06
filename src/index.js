const fs = require("fs");
const moo = require("moo");
const path = require("path");

// Load keywords, converting all to lower case
const keywords = fs
  .readFileSync(path.join(__dirname, "keywords.txt"), "utf8")
  .split("\n")
  .map((kw) => kw.trim().toLowerCase())
  .filter((kw) => Boolean(kw));

// Incoming values will also be compared as lower case to make keyword matching case insensitive
const caseInsensitiveKeywords = (defs) => {
  const keywords = moo.keywords(defs);
  return (value) => keywords(value.toLowerCase());
};

const lexer = moo.compile({
  whitespace: /[ \t]+/,
  newline: { match: /\n/, lineBreaks: true },
  lineComment: /--.*?$/,
  multiComment: /\/\*[^]*?\*\//,
  lparen: "(",
  rparen: ")",
  comma: ",",
  period: ".",

  number: /0|[1-9][0-9]*/,

  // ; is standard, \g is used for Actian dbs
  // Are there others?
  terminator: [";", "\\g"],

  // text == original text
  // value == value inside quotes
  quotedIdentifier: [
    {
      match: /".*?"/,
      value: (x) => x.slice(1, -1),
    },
    {
      match: /\[.*?\]/,
      value: (x) => x.slice(1, -1),
    },
  ],

  // text == original text
  // value == value inside quotes
  string: /'(?:\\['\\]|[^\n'\\])*'/,

  // Remaining test is assumed to be an identifier of some kinds (column or table)
  // UNLESS it matches a keyword case insensitively
  // The value of these tokens are converted to lower case
  identifier: {
    match: /[a-zA-Z_0-9]+/,
    type: caseInsensitiveKeywords({
      keyword: keywords,
    }),
    value: (s) => s.toLowerCase(),
  },

  // Any combination of special characters is to be treated as an operator (as a guess anyways)
  // Initially these were being noted here but the list is large
  // and there is no way to know all operators since this supports anything that is SQL-ish
  operator: {
    match: /[<>~!@#$%^?&|`*\-{}+=:/\\[\]]+/,
    lineBreaks: false,
  },
});

/**
 * Takes SQL text and generates an array of tokens using moo
 * @param {string} sqlText
 */
function tokenize(sqlText) {
  const tokens = [];
  lexer.reset(sqlText);
  let next = lexer.next();
  while (next) {
    tokens.push(next);
    next = lexer.next();
  }
  return tokens;
}

/**
 * Splits sql text into an array of arrays of tokens
 * @param {string} sqlText
 */
function getQueriesTokens(sqlText) {
  const tokens = tokenize(sqlText);
  const queriesTokens = [];
  let queryTokens = [];
  tokens.forEach((token) => {
    queryTokens.push(token);
    if (token.type === "terminator") {
      queriesTokens.push(queryTokens);
      queryTokens = [];
    }
  });
  // push last set
  queriesTokens.push(queryTokens);
  return queriesTokens;
}

/**
 * Find if a query is a select query or not.
 * CTEs *may* be a select. They could also be inserts/updates
 * @param {array<object>} queryTokens
 */
function getStatementType(queryTokens = []) {
  // Queries could be wrapped in parens (WITH something AS (some query) SELECT 'hello' AS world;)
  // In event that this query wrapped in parents, this needs to track what level of parens need the limit injected into
  let parenLevel = 0;
  let targetParenLevel;
  // statementKeyword will be `select`, `insert`, `alter`, etc.
  // keywords `with` and `as` not included to filter out cte
  let statementKeyword = "";
  let statementkeywordIndex;

  for (let index = 0; index < queryTokens.length; index++) {
    const token = queryTokens[index];
    if (token.type === "lparen") {
      parenLevel++;
    } else if (token.type === "rparen") {
      parenLevel--;
    } else if (token.type === "keyword") {
      // If targetParenLevel has not yet been set,
      // we are dealing with the first keyword, which informs us of the "level"
      // we want to consider for finding SELECT and TOP/FIRST/LIMIT
      if (targetParenLevel === undefined) {
        targetParenLevel = parenLevel;
      }
      // Statement keyword we are considering not something found in prep of CTE
      // If the current keyword isn't a `with` and not `as`, and at the same level as our targetParenLevel,
      // We can assume it tells us what kind of query we are dealing with.
      // Consider queries like the following queries
      //
      // WITH cte AS (...) SELECT ...
      // WITH cte AS (...) INSERT INTO ... SELECT
      // WITH cte AS (...) UPDATE ... FROM ...
      // (WITH cte AS (...) SELECT ...)
      if (
        !statementKeyword &&
        targetParenLevel === parenLevel &&
        token.value !== "with" &&
        token.value !== "as"
      ) {
        statementKeyword = token.value;
        statementkeywordIndex = index;

        // We've identified the statement keyword
        // We can exit the loop
        index = queryTokens.length;
      }
    }
  }

  return {
    statementkeywordIndex,
    statementKeyword,
  };
}

function nextKeyword(tokens, startingIndex) {
  let level = 0;
  for (let i = startingIndex; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "lparen") {
      level++;
    } else if (token.type === "rparen") {
      level--;
    } else if (token.type === "keyword" && level === 0) {
      return { ...token, index: i };
    }
  }
}

function nextNonCommentNonWhitespace(tokens, startingIndex) {
  const ignoreTypes = ["whitespace", "newline", "lineComment", "multiComment"];
  for (let i = startingIndex; i < tokens.length; i++) {
    const token = tokens[i];
    const shouldIgnore = ignoreTypes.includes(token.type);
    if (!shouldIgnore) {
      return { ...token, index: i };
    }
  }
}

function enforceTopOrFirst(queryTokens, limitKeyword = "", limit) {
  const { statementKeyword, statementkeywordIndex } = getStatementType(
    queryTokens
  );

  // If not dealing with a select return tokens unaltered
  if (statementKeyword !== "select") {
    return queryTokens;
  }

  const nextKeywordToken = nextKeyword(queryTokens, statementkeywordIndex + 1);
  if (nextKeywordToken.value !== limitKeyword.toLowerCase()) {
    // not there so inject it
    const injectedTokens = [
      {
        type: "whitespace",
        text: " ",
        value: " ",
      },
      {
        type: "keyword",
        text: limitKeyword,
        value: limitKeyword.toLowerCase(),
      },
      {
        type: "whitespace",
        text: " ",
        value: " ",
      },
      {
        type: "number",
        text: `${limit}`,
        value: `${limit}`,
      },
      {
        type: "whitespace",
        text: " ",
        value: " ",
      },
    ];
    const firstHalf = queryTokens.slice(0, statementkeywordIndex + 1);
    const secondhalf = queryTokens.slice(statementkeywordIndex + 1);
    return [...firstHalf, ...injectedTokens, ...secondhalf];
  } else {
    // is the next non-whitespace non-comment a number?
    // If so, enforce that number be no larger than limit
    const next = nextNonCommentNonWhitespace(
      queryTokens,
      nextKeywordToken.index + 1
    );

    // If not found for some reason, or type is not a number, return queryTokens untouched
    if (!next || next.type !== "number") {
      return queryTokens;
    }

    const n = parseInt(next.value, 10);

    // If the number if over the limit, reset it
    if (n > limit) {
      const firstHalf = queryTokens.slice(0, next.index);
      const secondhalf = queryTokens.slice(next.index + 1);
      return [
        ...firstHalf,
        { ...next, text: limit, value: limit },
        ...secondhalf,
      ];
    }
    return queryTokens;
  }
}

// function hasLimit() {
//   // TODO
// }

// /**
//  * Find if a limit is set, and enforce it or add it depending on the scenario
//  * @param {array<object>} queryTokens
//  * @param {number} enforcedLimit - limit to enforce
//  * @param {string} limitType - LIMIT, TOP, FIRST
//  */
// function limitize(queryTokens = [], enforcedLimit, limitType = "LIMIT") {
//   // TODO
// }

/**
 * Takes SQL text and splits it by terminator
 * Returns array of single SQL statements.
 * Extra spaces trailing terminator are not returned for a query
 * @param {string} sqlText
 * @param {boolean} includeTerminators = include terminators in individual queries
 */
function getQueries(sqlText, includeTerminators = false) {
  const queries = [];
  const queriesTokens = getQueriesTokens(sqlText);
  queriesTokens.forEach((queryTokens) => {
    // if set of tokens has something other than whitespace/terminators, consider it
    if (
      queryTokens.filter(
        (t) =>
          t.type !== "whitespace" &&
          t.type !== "terminator" &&
          t.type !== "newline"
      ).length > 0
    ) {
      if (includeTerminators) {
        const query = queryTokens.map((token) => token.text).join("");
        queries.push(query);
      } else {
        const query = queryTokens
          .filter((token) => token.type !== "terminator")
          .map((token) => token.text)
          .join("");
        queries.push(query);
      }
    }
  });
  return queries;
}

module.exports = {
  getQueries,
  getQueriesTokens,
  tokenize,
  getStatementType,
  enforceTopOrFirst,
};