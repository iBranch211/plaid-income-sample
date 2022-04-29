"use strict";
require("dotenv").config();
const fs = require("fs/promises");
const express = require("express");
const bodyParser = require("body-parser");
const { Configuration, PlaidEnvironments, PlaidApi } = require("plaid");
const { v4: uuidv4 } = require("uuid");

const APP_PORT = process.env.APP_PORT || 8080;
const USER_DATA_FILE = "user_data.json";

const FIELD_ACCESS_TOKEN = "accessToken";
const FIELD_USER_TOKEN = "incomeUserToken";
const FIELD_INCOME_CONNECTED = "incomeConnected";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const server = app.listen(APP_PORT, function () {
  console.log(`Server is up and running at http://localhost:${APP_PORT}/`);
});

// Set up the Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
      "Plaid-Version": "2020-09-14",
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// Instead of using a database to store our user token, we're writing it
// to a flat file. Unlike our session storage solution, this survives restarting
// the server. Convenient for demo purposes, a terrible idea for a production
// app.

const getUserRecord = async function () {
  try {
    const userData = await fs.readFile(USER_DATA_FILE, {
      encoding: "utf8",
    });
    const userDataObj = await JSON.parse(userData);
    console.log(`Retrieved userData ${userData}`);
    return userDataObj;
  } catch (error) {
    // Might happen first time, since file doesn't exist
    console.log("Got an error", error);
    return null;
  }
};

let userRecord;
(async () => {
  userRecord = await getUserRecord();
})();

const updateUserRecord = async function (key, val) {
  userRecord[key] = val;
  try {
    const dataToWrite = JSON.stringify(userRecord);
    await fs.writeFile(USER_DATA_FILE, dataToWrite, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`User record ${dataToWrite} written to file.`);
  } catch (error) {
    console.log("Got an error: ", error);
  }
};

const getLazyUserID = async function () {
  if (userRecord.userId != null && userRecord.userId !== "") {
    return userRecord.userId;
  } else {
    // Let's lazily instantiate it!
    const randomUserId = "user_" + uuidv4();
    await updateUserRecord("userId", randomUserId);
    return randomUserId;
  }
};

// Checks whether or not the user has an access token for a financial
// institution
app.get("/appServer/getUserInfo", async (req, res, next) => {
  try {
    if (req.query.income) {
      const income_status = userRecord[FIELD_INCOME_CONNECTED];
      return income_status != null && income_status === true
        ? res.json({ status: true })
        : res.json({ status: false });
    } else {
      const user_token = userRecord[FIELD_ACCESS_TOKEN];
      return user_token != null && user_token !== ""
        ? res.json({ status: true })
        : res.json({ status: false });
    }
  } catch (error) {
    next(error);
  }
});

const basicLinkTokenObject = {
  user: { client_user_id: "testUser" },
  client_name: "Todd's Hoverboards",
  language: "en",
  products: [],
  country_codes: ["US"],
  webhook: "https://www.example.com/webhook",
};

app.post("/appServer/generateLinkToken", async (req, res, next) => {
  try {
    let response;
    if (req.body.income === true) {
      const userToken = await fetchOrCreateUserToken();
      console.log(`User token returned: ${userToken}`);
      const income_verification_object =
        req.body.incomeType === "payroll"
          ? { income_source_types: ["payroll"] }
          : {
              income_source_types: ["bank"],
              bank_income: { days_requested: 60 },
            };

      const newIncomeTokenObject = {
        ...basicLinkTokenObject,
        products: ["income_verification"],
        user_token: userToken,
        income_verification: income_verification_object,
      };
      console.log(
        `Here's your token object: ${JSON.stringify(newIncomeTokenObject)}`
      );
      response = await plaidClient.linkTokenCreate(newIncomeTokenObject);
    } else {
      const newLiabilitiesTokenObject = {
        ...basicLinkTokenObject,
        products: ["liabilities"],
      };
      response = await plaidClient.linkTokenCreate(newLiabilitiesTokenObject);
    }
    res.json(response.data);
  } catch (error) {
    console.log(`Running into an error!`);
    next(error);
  }
});

app.post("/appServer/swapPublicToken", async (req, res, next) => {
  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    console.log(`You got back ${JSON.stringify(response.data)}`);
    updateUserRecord(FIELD_ACCESS_TOKEN, response.data.access_token);
    res.json({ status: "success" });
  } catch (error) {
    next(error);
  }
});

app.post("/appServer/incomeWasSuccessful", async (req, res, next) => {
  try {
    updateUserRecord(FIELD_INCOME_CONNECTED, true);
    res.json({ status: true });
  } catch (error) {
    next(error);
  }
});

app.get("/appServer/fetchLiabilities", async (req, res, next) => {
  try {
    const response = await plaidClient.liabilitiesGet({
      access_token: userRecord[FIELD_ACCESS_TOKEN],
    });
    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

const fetchOrCreateUserToken = async () => {
  const userToken = userRecord[FIELD_USER_TOKEN];
  console.log(`Trying to fetch local user token. Got ${userToken}`);

  if (userToken == null || userToken === "") {
    // We're gonna need to generate one!
    const userId = await getLazyUserID();
    console.log(`Got a user ID of ${userId}`);
    const response = await plaidClient.userCreate({
      client_user_id: userId,
    });
    const newUserToken = response.data.user_token;
    console.log(`New user token is  ${newUserToken}`);
    // We'll save this because this only needs to be done once per user
    updateUserRecord(FIELD_USER_TOKEN, newUserToken);
    return newUserToken;
  } else {
    return userToken;
  }
};

app.get("/appServer/getPayrollIncome", async (req, res, next) => {
  try {
    const response = await plaidClient.creditPayrollIncomeGet({
      user_token: userRecord[FIELD_USER_TOKEN],
    });

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

app.get("/appServer/getBankIncome", async (req, res, next) => {
  try {
    const response = await plaidClient.creditBankIncomeGet({
      user_token: userRecord[FIELD_USER_TOKEN],
      options: {
        count: 3,
      },
    });

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

const errorHandler = function (err, req, res, next) {
  console.error(`Your error: ${JSON.stringify(err)}`);
  console.error(err);
  if (err.response?.data != null) {
    res.status(500).send(err.response.data);
  } else {
    res.status(500).send({
      error_code: "OTHER_ERROR",
      error_message: "I got some other message on the server.",
    });
  }
};
app.use(errorHandler);