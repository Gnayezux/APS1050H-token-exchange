import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import tokensConfig from './tokensConfig.json';
import { EXCHANGE_ADDRESS, EXCHANGE_ABI, ERC20_ABI } from './exchangeConfig';
import { RefreshCw, AlertCircle, ShoppingCart, ClipboardPaste } from 'lucide-react';

const tokenByAddress = Object.fromEntries(tokensConfig.map(t => [t.address.toLowerCase(), t]));

function shortAddr(addr) {
  return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
}

export default function ExploreOrders({ account }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [buyAmounts, setBuyAmounts] = useState({});
  const [filling, setFilling] = useState({});
  const [fillStatus, setFillStatus] = useState({});

  // Gasless fill state
  const [gaslessJson, setGaslessJson] = useState('');
  const [gaslessAmount, setGaslessAmount] = useState('');
  const [gaslessStatus, setGaslessStatus] = useState(null);
  const [gaslessFilling, setGaslessFilling] = useState(false);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    if (!window.ethereum) { setError('MetaMask not found.'); setLoading(false); return; }
    try {
      setLoading(true);
      setError(null);

      const provider = new ethers.BrowserProvider(window.ethereum);
      const exchange = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);

      // Fetch all PostedOrder events
      const filter = exchange.filters.PostedOrder();
      const events = await exchange.queryFilter(filter, -50000);

      const now = Math.floor(Date.now() / 1000);

      const enriched = await Promise.all(events.map(async (e) => {
        const { _seller, _tokenSold, _tokenWant, _amountSold, _amountWant, _expiry, _nonce, _sig } = e.args;
        const hash = e.args._hash;

        const data = await exchange.hashToData(hash);
        const soldLeft = data.soldLeft;
        const buyerNonce = data.buyerNonce;
        const expired = Number(_expiry) < now;

        const tokenSoldMeta = tokenByAddress[_tokenSold.toLowerCase()];
        const tokenWantMeta = tokenByAddress[_tokenWant.toLowerCase()];

        // Get decimals
        let decimalsSold = 18, decimalsWant = 18;
        try {
          const tsc = new ethers.Contract(_tokenSold, ERC20_ABI, provider);
          const twc = new ethers.Contract(_tokenWant, ERC20_ABI, provider);
          decimalsSold = Number(await tsc.decimals());
          decimalsWant = Number(await twc.decimals());
        } catch {}

        return {
          hash,
          seller: _seller,
          tokenSold: _tokenSold,
          tokenWant: _tokenWant,
          amountSold: _amountSold,
          amountWant: _amountWant,
          expiry: Number(_expiry),
          nonce: _nonce,
          sig: _sig,
          soldLeft,
          buyerNonce,
          expired,
          decimalsSold,
          decimalsWant,
          tokenSoldMeta,
          tokenWantMeta,
          active: soldLeft > 0n && !expired,
        };
      }));

      // Show active orders first
      enriched.sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));
      setOrders(enriched);
    } catch (err) {
      console.error(err);
      setError('Failed to load orders: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleFill = async (order) => {
    if (!window.ethereum) return;
    const amountStr = buyAmounts[order.hash] || '';
    if (!amountStr || isNaN(amountStr) || parseFloat(amountStr) <= 0) {
      setFillStatus(p => ({ ...p, [order.hash]: { type: 'error', message: 'Enter a valid amount to buy.' } }));
      return;
    }

    try {
      setFilling(p => ({ ...p, [order.hash]: true }));
      setFillStatus(p => ({ ...p, [order.hash]: null }));

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const amountToBuy = ethers.parseUnits(amountStr, order.decimalsSold);
      if (amountToBuy > order.soldLeft) {
        setFillStatus(p => ({ ...p, [order.hash]: { type: 'error', message: 'Amount exceeds available supply.' } }));
        return;
      }

      // Calculate how much buyer needs to pay
      const ratio = (amountToBuy * BigInt(1e18)) / order.amountSold;
      const amountToSeller = (order.amountWant * ratio) / BigInt(1e18);

      // Step 1: Approve Exchange to spend buyer's tokenWant
      setFillStatus(p => ({ ...p, [order.hash]: { type: 'info', message: 'Step 1/2: Approving payment token...' } }));
      const tokenWantContract = new ethers.Contract(order.tokenWant, ERC20_ABI, signer);
      const allowance = await tokenWantContract.allowance(account, EXCHANGE_ADDRESS);
      if (allowance < amountToSeller) {
        const approveTx = await tokenWantContract.approve(EXCHANGE_ADDRESS, amountToSeller);
        await approveTx.wait();
      }

      // Step 2: Fill order
      setFillStatus(p => ({ ...p, [order.hash]: { type: 'info', message: 'Step 2/2: Submitting fill...' } }));
      const exchange = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, signer);
      const tx = await exchange.fillOrder(
        order.tokenSold,
        order.tokenWant,
        {
          seller: order.seller,
          amountSold: order.amountSold,
          amountWant: order.amountWant,
          expiry: BigInt(order.expiry),
          nonce: order.nonce,
          sig: order.sig,
          amountToBuy,
          buyerNonce: order.buyerNonce,
        }
      );
      await tx.wait();

      setFillStatus(p => ({ ...p, [order.hash]: { type: 'success', message: `Filled! Tx: ${tx.hash}` } }));
      fetchOrders();
    } catch (err) {
      console.error(err);
      setFillStatus(p => ({ ...p, [order.hash]: { type: 'error', message: err.reason || err.message } }));
    } finally {
      setFilling(p => ({ ...p, [order.hash]: false }));
    }
  };

  const handleFillGasless = async () => {
    if (!window.ethereum) return;
    if (!gaslessJson.trim()) {
      setGaslessStatus({ type: 'error', message: 'Paste a signed order JSON first.' });
      return;
    }
    if (!gaslessAmount || isNaN(gaslessAmount) || parseFloat(gaslessAmount) <= 0) {
      setGaslessStatus({ type: 'error', message: 'Enter a valid amount to buy.' });
      return;
    }

    let order;
    try {
      order = JSON.parse(gaslessJson);
    } catch {
      setGaslessStatus({ type: 'error', message: 'Invalid JSON. Paste the full signed order.' });
      return;
    }

    const required = ['seller', 'tokenSold', 'tokenWant', 'amountSold', 'amountWant', 'expiry', 'nonce', 'sig'];
    const missing = required.filter(k => !order[k]);
    if (missing.length) {
      setGaslessStatus({ type: 'error', message: `Missing fields: ${missing.join(', ')}` });
      return;
    }

    try {
      setGaslessFilling(true);
      setGaslessStatus(null);

      const provider = new ethers.BrowserProvider(window.ethereum);
      const network = await provider.getNetwork();
      if (network.chainId !== 11155111n) {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0xaa36a7' }],
        });
      }
      const signer = await provider.getSigner();

      // Get decimals for tokenSold to parse amountToBuy
      const tokenSoldContract = new ethers.Contract(order.tokenSold, ERC20_ABI, provider);
      const decimalsSold = Number(await tokenSoldContract.decimals());
      const amountToBuy = ethers.parseUnits(gaslessAmount, decimalsSold);
      const amountSold = BigInt(order.amountSold);

      if (amountToBuy > amountSold) {
        setGaslessStatus({ type: 'error', message: 'Amount exceeds the total order size.' });
        return;
      }

      // Calculate how much tokenWant buyer must pay
      const ratio = (amountToBuy * BigInt(1e18)) / amountSold;
      const amountToSeller = (BigInt(order.amountWant) * ratio) / BigInt(1e18);

      // Approve Exchange to spend buyer's tokenWant
      setGaslessStatus({ type: 'info', message: 'Step 1/2: Approving payment token...' });
      const tokenWantContract = new ethers.Contract(order.tokenWant, ERC20_ABI, signer);
      const allowance = await tokenWantContract.allowance(account, EXCHANGE_ADDRESS);
      if (allowance < amountToSeller) {
        const approveTx = await tokenWantContract.approve(EXCHANGE_ADDRESS, amountToSeller);
        await approveTx.wait();
      }

      // Read current buyerNonce from contract
      const exchange = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, provider);
      // For gasless orders not yet on-chain, buyerNonce starts at 0
      let buyerNonce = 0n;
      try {
        // The hash might already be in hashToData if partially filled before
        // We can't compute the hash client-side easily, so we just use 0 for fresh orders
        // and let the contract revert if wrong
      } catch {}

      setGaslessStatus({ type: 'info', message: 'Step 2/2: Submitting fill...' });
      const exchangeWrite = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, signer);
      const tx = await exchangeWrite.fillOrder(
        order.tokenSold,
        order.tokenWant,
        {
          seller: order.seller,
          amountSold: BigInt(order.amountSold),
          amountWant: BigInt(order.amountWant),
          expiry: BigInt(order.expiry),
          nonce: BigInt(order.nonce),
          sig: order.sig,
          amountToBuy,
          buyerNonce,
        }
      );
      await tx.wait();

      setGaslessStatus({ type: 'success', message: `Filled! Tx: ${tx.hash}` });
      setGaslessJson('');
      setGaslessAmount('');
      fetchOrders();
    } catch (err) {
      console.error(err);
      setGaslessStatus({ type: 'error', message: err.reason || err.message });
    } finally {
      setGaslessFilling(false);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-6 bg-white rounded-2xl shadow-sm border border-slate-200">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Explore Orders</h2>
          <p className="text-slate-500 text-sm">Browse and fill open orders on the exchange.</p>
        </div>
        <button
          onClick={fetchOrders}
          disabled={loading}
          className="p-2 text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 rounded-xl transition-all disabled:opacity-50 border border-slate-200"
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin text-indigo-600' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-xl flex items-start border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3 flex-shrink-0 mt-0.5" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading && orders.length === 0 && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-slate-500">Loading orders from blockchain...</p>
        </div>
      )}

      {!loading && orders.length === 0 && !error && (
        <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
          <ShoppingCart className="w-12 h-12 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-500">No orders found on this contract yet.</p>
        </div>
      )}

      <div className="space-y-4">
        {orders.map(order => {
          const soldSymbol = order.tokenSoldMeta?.symbol || shortAddr(order.tokenSold);
          const wantSymbol = order.tokenWantMeta?.symbol || shortAddr(order.tokenWant);
          const soldLeftFormatted = ethers.formatUnits(order.soldLeft, order.decimalsSold);
          const totalSold = ethers.formatUnits(order.amountSold, order.decimalsSold);
          const totalWant = ethers.formatUnits(order.amountWant, order.decimalsWant);
          const rate = (parseFloat(totalWant) / parseFloat(totalSold)).toFixed(4);
          const status = fillStatus[order.hash];
          const isMine = order.seller.toLowerCase() === account?.toLowerCase();

          return (
            <div
              key={order.hash}
              className={`p-5 border rounded-xl ${order.active ? 'border-slate-200 bg-slate-50' : 'border-slate-100 bg-slate-50 opacity-60'}`}
            >
              <div className="flex flex-wrap justify-between items-start gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-slate-900">
                      {totalSold} {soldSymbol} → {totalWant} {wantSymbol}
                    </span>
                    {isMine && (
                      <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">Yours</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    Rate: 1 {soldSymbol} = {rate} {wantSymbol} · Seller: {shortAddr(order.seller)}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Available: <span className="font-semibold text-slate-700">{soldLeftFormatted} {soldSymbol}</span>
                    {' · '}
                    Expires: {new Date(order.expiry * 1000).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!order.active && (
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${order.expired ? 'bg-yellow-100 text-yellow-700' : 'bg-slate-200 text-slate-500'}`}>
                      {order.expired ? 'Expired' : 'Filled'}
                    </span>
                  )}
                  {order.active && (
                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-green-100 text-green-700">Active</span>
                  )}
                </div>
              </div>

              {order.active && !isMine && (
                <div className="flex flex-col gap-2 pt-3 border-t border-slate-200">
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      placeholder={`Amount of ${soldSymbol} to buy`}
                      value={buyAmounts[order.hash] || ''}
                      onChange={e => setBuyAmounts(p => ({ ...p, [order.hash]: e.target.value }))}
                      className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                      disabled={filling[order.hash]}
                    />
                    <button
                      onClick={() => handleFill(order)}
                      disabled={filling[order.hash]}
                      className="flex items-center bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    >
                      {filling[order.hash] ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <>
                          <ShoppingCart className="w-4 h-4 mr-1.5" />
                          Fill
                        </>
                      )}
                    </button>
                  </div>
                  {status && (
                    <div className={`p-3 rounded-lg text-xs border ${
                      status.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' :
                      status.type === 'success' ? 'bg-green-50 text-green-700 border-green-100' :
                      'bg-indigo-50 text-indigo-700 border-indigo-100'
                    }`}>
                      <p className="break-all">{status.message}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Gasless fill section */}
      <div className="mt-8 pt-6 border-t border-slate-200">
        <div className="flex items-center gap-2 mb-1">
          <ClipboardPaste className="w-5 h-5 text-purple-600" />
          <h3 className="text-lg font-bold text-slate-900">Fill a Gasless Order</h3>
        </div>
        <p className="text-slate-500 text-sm mb-4">
          Paste a signed order JSON shared by a seller. The seller pays no gas — you submit it on-chain.
        </p>

        <div className="space-y-3">
          <textarea
            rows={5}
            placeholder={'Paste signed order JSON here...\n{\n  "seller": "0x...",\n  "tokenSold": "0x...",\n  ...'}
            value={gaslessJson}
            onChange={e => setGaslessJson(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-purple-500 outline-none resize-none"
            disabled={gaslessFilling}
          />

          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              placeholder="Amount of tokenSold to buy"
              value={gaslessAmount}
              onChange={e => setGaslessAmount(e.target.value)}
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 outline-none"
              disabled={gaslessFilling}
            />
            <button
              onClick={handleFillGasless}
              disabled={gaslessFilling}
              className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              {gaslessFilling ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <ShoppingCart className="w-4 h-4" />
                  Fill
                </>
              )}
            </button>
          </div>

          {gaslessStatus && (
            <div className={`p-3 rounded-lg text-sm border ${
              gaslessStatus.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' :
              gaslessStatus.type === 'success' ? 'bg-green-50 text-green-700 border-green-100' :
              'bg-purple-50 text-purple-700 border-purple-100'
            }`}>
              <p className="break-all">{gaslessStatus.message}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
