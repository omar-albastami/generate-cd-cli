const axios = require('axios');

const getServices = async (bearerToken) => {
    const options = {
        url: 'https://api.us-south.devops.dev.cloud.ibm.com/v1/services',
        headers: {
            'Authorization': `Bearer ${bearerToken}`
        }
    };
    const response = await axios(options);
    if (response.status !== 200) {
        throw new Error (response.statusText);
    }
    return response.data;
};

module.exports = {
    getServices
};