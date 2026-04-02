// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.32;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract Exchange is EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    struct MapStruct {
        uint buyerNonce;
        address seller;
        uint soldLeft;
    }

    struct FillOrderStruct {
        address seller;
        uint amountSold;
        uint amountWant;
        uint expiry;
        uint nonce;
        bytes sig;
        uint amountToBuy;
        uint buyerNonce;
    }

    // Wraps a FillOrderStruct with its token pair for use in bulkFillOrders.
    struct BulkFillOrderItem {
        IERC20 tokenSold;
        IERC20 tokenWant;
        FillOrderStruct order;
    }

    mapping (bytes32 => MapStruct) public hashToData;

    uint internal constant WAD = 1e18;
    bytes32 internal constant TYPE_HASH = keccak256(
        "Order(address tokenSold,address tokenWant,uint256 amountSold,uint256 amountWant,uint256 expiry,uint256 nonce)"
    );

    event PostedOrder(address _seller, IERC20 indexed _tokenSold, IERC20 indexed _tokenWant, uint _amountSold, uint _amountWant, uint _expiry, uint _nonce, bytes _sig, bytes32 indexed _hash);
    event BoughtOrder(address _buyer, IERC20 indexed _tokenSold, IERC20 indexed _tokenWant, uint _amountSold);
    event CanceledOrder(address _seller, bytes32 indexed _hash);

    constructor() EIP712('AA-Batteries Exchange', '1') {}

    function _getHash(
        IERC20 tokenSold,
        IERC20 tokenWant,
        uint amountSold,
        uint amountWant,
        uint expiry,
        uint nonce
    ) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(TYPE_HASH, tokenSold, tokenWant, amountSold, amountWant, expiry, nonce))
        );
    }

    function _verifySig(
        bytes32 orderHash,
        bytes calldata sig,
        address sender
    ) internal pure returns (bool) {
        return ECDSA.recover(orderHash, sig) == sender;
    }

    function _verifyOrderSigExpiry(
        FillOrderStruct calldata order,
        bytes32 orderHash
    ) internal view {
        require(_verifySig(orderHash, order.sig, order.seller), "Cannot verify signature!");
        require(block.timestamp < order.expiry, "Order has already expired!");
    }

    // Lets a seller publish an order.
    function createOrder(
        IERC20 tokenSold,
        IERC20 tokenWant,
        uint amountSold,
        uint amountWant,
        uint expiry,
        uint nonce,
        bytes calldata sig
    ) external {
        bytes32 orderHash = _getHash(tokenSold, tokenWant, amountSold, amountWant, expiry, nonce);
        require(_verifySig(orderHash, sig, msg.sender), "Cannot verify signature!");
        require(hashToData[orderHash].seller == address(0), "Order has already been posted!");

        hashToData[orderHash].seller = msg.sender;
        hashToData[orderHash].soldLeft = amountSold;
        emit PostedOrder(msg.sender, tokenSold, tokenWant, amountSold, amountWant, expiry, nonce, sig, orderHash);
    }

    // Allows a seller to cancel their posted sell-order.
    // The order must have been posted via createOrder first; this prevents
    // a griefing attack where anyone could lock an unposted order hash.
    function cancelOrder(
        IERC20 tokenSold,
        IERC20 tokenWant,
        uint amountSold,
        uint amountWant,
        uint expiry,
        uint nonce,
        bytes calldata sig
    ) external {
        bytes32 orderHash = _getHash(tokenSold, tokenWant, amountSold, amountWant, expiry, nonce);
        require(_verifySig(orderHash, sig, msg.sender), "Cannot verify signature!");
        require(hashToData[orderHash].seller == msg.sender, "This order is not yours to cancel!");

        hashToData[orderHash].soldLeft = 0;
        emit CanceledOrder(msg.sender, orderHash);
    }

    // Allows a buyer to check if their fill order can be fulfilled.
    // Pass order.buyerNonce = hashToData[orderHash].buyerNonce (the current stored value).
    // Returns true if it can, false or reverts if not.
    function isOrderFillable(
        IERC20 tokenSold,
        IERC20 tokenWant,
        FillOrderStruct calldata order
    ) external view returns (bool) {
        bytes32 orderHash = _getHash(tokenSold, tokenWant, order.amountSold, order.amountWant, order.expiry, order.nonce);
        _verifyOrderSigExpiry(order, orderHash);

        return order.amountToBuy > 0
            && tokenSold.allowance(order.seller, address(this)) >= order.amountToBuy
            && hashToData[orderHash].soldLeft >= order.amountToBuy
            && hashToData[orderHash].buyerNonce == order.buyerNonce;
    }

    // Buyer purchases order.amountToBuy tokens of tokenSold, paying a proportional
    // amount of tokenWant to the seller.
    // order.buyerNonce must equal the current hashToData[orderHash].buyerNonce.
    // Supports gasless orders: if the seller has not called createOrder, the order
    // state is initialized here from their verified off-chain signature.
    function fillOrder(
        IERC20 tokenSold,
        IERC20 tokenWant,
        FillOrderStruct calldata order
    ) public {
        require(order.amountToBuy > 0, "amountToBuy must be greater than zero!");

        bytes32 orderHash = _getHash(tokenSold, tokenWant, order.amountSold, order.amountWant, order.expiry, order.nonce);
        _verifyOrderSigExpiry(order, orderHash);

        if (hashToData[orderHash].seller == address(0)) {
            // Gasless path: seller signed off-chain, buyer submits on-chain.
            hashToData[orderHash].seller = order.seller;
            hashToData[orderHash].soldLeft = order.amountSold;
        }

        require(hashToData[orderHash].buyerNonce == order.buyerNonce, "Incorrect nonce! Read hashToData for the current nonce.");
        hashToData[orderHash].buyerNonce++;

        hashToData[orderHash].soldLeft -= order.amountToBuy;
        uint ratio = (order.amountToBuy * WAD) / order.amountSold;
        uint amountToSeller = (order.amountWant * ratio) / WAD;

        tokenSold.safeTransferFrom(order.seller, msg.sender, order.amountToBuy);
        tokenWant.safeTransferFrom(msg.sender, order.seller, amountToSeller);
        emit BoughtOrder(msg.sender, tokenSold, tokenWant, order.amountToBuy);
    }
}
