const axios = require('axios');
const nconf = require('nconf');

const getBearerToken = async () => {
    const params = new URLSearchParams();
    params.append('grant_type', 'urn:ibm:params:oauth:grant-type:apikey');
    params.append('apikey', nconf.get('IBM_CLOUD_API_KEY'));
    params.append('response_type', 'cloud_iam');
    const options = {
        method: 'POST',
        url: 'https://iam.test.cloud.ibm.com/identity/token',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: params
    };
    const response = await axios(options);
    if (response.status !== 200) {
        throw new Error (response.statusText);
    }
    return response.data.access_token;
};

module.exports = {
    getBearerToken
};