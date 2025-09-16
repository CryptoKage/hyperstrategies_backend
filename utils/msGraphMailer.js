// PASTE THIS ENTIRE CONTENT INTO: hyperstrategies_backend/utils/msGraphMailer.js

require('isomorphic-fetch');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');

// Configuration for MSAL (Microsoft Authentication Library)
const msalConfig = {
  auth: {
    clientId: process.env.MS_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
    clientSecret: process.env.MS_CLIENT_SECRET,
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

/**
 * Acquires an authentication token from Azure AD.
 * @returns {Promise<string>} A promise that resolves to an access token.
 */
async function getAuthToken() {
  const tokenRequest = {
    scopes: ['https://graph.microsoft.com/.default'],
  };
  const response = await cca.acquireTokenByClientCredential(tokenRequest);
  return response.accessToken;
}

/**
 * Sends an email using the Microsoft Graph API.
 * @param {object} mailOptions - The email options.
 * @param {string} mailOptions.to - The recipient's email address.
 * @param {string} mailOptions.subject - The subject of the email.
 * @param {string} mailOptions.html - The HTML body of the email.
 */
async function sendEmail(mailOptions) {
  try {
    const accessToken = await getAuthToken();

    // Initialize the Microsoft Graph client
    const client = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });

    // Construct the email message object for the Graph API
    const message = {
      subject: mailOptions.subject,
      body: {
        contentType: 'HTML',
        content: mailOptions.html,
      },
      toRecipients: [
        {
          emailAddress: {
            address: mailOptions.to,
          },
        },
      ],
    };

    // Send the email from the user specified in the environment variables
    await client.api(`/users/${process.env.MS_MAILER_USER_EMAIL}/sendMail`).post({
      message,
      saveToSentItems: 'true', // Optional: save a copy in the "Sent Items" folder
    });

    console.log(`✅ Successfully sent email to ${mailOptions.to} via MS Graph API.`);
  } catch (error) {
    console.error('❌ MS Graph Mailer Error:', error?.body || error.message);
    // We re-throw the error so the calling function knows it failed.
    throw new Error('Failed to send email via Microsoft Graph API.');
  }
}

module.exports = { sendEmail };
