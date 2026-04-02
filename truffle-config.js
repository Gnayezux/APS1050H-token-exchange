const HDWalletProvider = require('@truffle/hdwallet-provider');
require('dotenv').config();

module.exports = {
  contracts_directory: './contract',
  migrations_directory: './migrations',

  networks: {
    development: {
      host: '127.0.0.1',
      port: 8545,
      network_id: '*',
    },
    sepolia: {
      provider: () => new HDWalletProvider(
        process.env.PRIVATE_KEY.replace(/^0x/, ''),
        process.env.SEPOLIA_RPC_URL,
      ),
      network_id: 11155111,
      confirmations: 2,
      timeoutBlocks: 200,
      networkCheckTimeout: 30000,
      skipDryRun: false,
    },
  },

  compilers: {
    solc: {
      version: '0.8.32',
    },
  },
};
