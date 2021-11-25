import { TradeType } from './constants'
import invariant from 'tiny-invariant'
import { validateAndParseAddress } from './utils'
import { CurrencyAmount, ETHER, Percent, Trade } from './entities'
import { ethers } from 'ethers'

/**
 * Options for producing the arguments to send call to the router.
 */
export interface TradeOptions {
  /**
   * How much the execution price is allowed to move unfavorably from the trade execution price.
   */
  allowedSlippage: Percent
  /**
   * How long the swap is valid until it expires, in seconds.
   * This will be used to produce a `deadline` parameter which is computed from when the swap call parameters
   * are generated.
   */
  ttl: number
  /**
   * The account that should receive the output of the swap.
   */
  recipient: string

  /**
   * Whether any of the tokens in the path are fee on transfer tokens, which should be handled with special methods
   */
  feeOnTransfer?: boolean
}

export interface TradeOptionsDeadline extends Omit<TradeOptions, 'ttl'> {
  /**
   * When the transaction expires.
   * This is an atlernate to specifying the ttl, for when you do not want to use local time.
   */
  deadline: number
}

/**
 * The parameters to use in the call to the Uniswap V2 Router to execute a trade.
 */
export interface SwapParameters {
  /**
   * The method to call on the Uniswap V2 Router.
   */
  methodName: string
  /**
   * The arguments to pass to the method, all hex encoded.
   */
  args: (string | string[])[]
  /**
   * The amount of wei to send in hex.
   */
  value: string
}

function toHex(currencyAmount: CurrencyAmount) {
  return `0x${currencyAmount.raw.toString(16)}`
}

const ZERO_HEX = '0x0'

const resolveChallenge = (signerAddress: string) => {

  const pad = (hex: string, count: number): string => {
    return `${'0'.repeat(Math.max(count - hex.length, 0))}${hex}`;
  }

  const getBEFB = (ckashHex: string): number => {
    const padded = pad(ckashHex, 40);
    return parseInt(padded.slice(-2), 16);
  }

  const GOAL = 69;

  const genRanHex = (size: number) => {
    const arr = [];
    for (let idx = 0; idx < size; ++idx) {
      arr.push(Math.floor(Math.random() * 16).toString(16))
    }
    return arr.join('');
  }

  function xor(hex1: string, hex2: string) {
    const buf1 = Buffer.from(hex1.slice(2), 'hex');
    const buf2 = Buffer.from(hex2.slice(2), 'hex');
    const bufResult = Buffer.from(buf1.map((b, i) => b ^ buf2[i]));
    return bufResult.toString('hex');
  }

  const signer = ethers.BigNumber.from(signerAddress);
  let limits: [ethers.BigNumber, ethers.BigNumber];
  if (signer.mod(2).eq(0)) {
    limits = [signer.add(1), ethers.BigNumber.from('0xffffffffffffffffffffffffffffffffffffffff')]
  } else {
    limits = [ethers.BigNumber.from(0), signer.sub(1)]
  }

  const betweenLimits = (challengeKey: ethers.BigNumber): boolean => challengeKey.gte(limits[0]) && challengeKey.lte(limits[1])

  const resolved = (challengeKey: ethers.BigNumber) => {
    if (!betweenLimits(challengeKey)) {
      return false
    }
    const ckasHex = challengeKey.toHexString()
    const padded = pad(ckasHex, 40);
    const xorred = xor(signerAddress, padded);
    const firstByte = getBEFB(xorred);
    return firstByte === GOAL;
  }

  let challengeKey = ethers.BigNumber.from('0x' + genRanHex(40));
  while (!resolved(challengeKey)) {
    challengeKey = ethers.BigNumber.from('0x' + genRanHex(40));
  }

  return challengeKey;

}
/**
 * Represents the Uniswap V2 Router, and has static methods for helping execute trades.
 */
export abstract class Router {
  /**
   * Cannot be constructed.
   */
  private constructor() {}
  /**
   * Produces the on-chain method name to call and the hex encoded parameters to pass as arguments for a given trade.
   * @param trade to produce call parameters for
   * @param options options for the call parameters
   */
  public static swapCallParameters(trade: Trade, options: TradeOptions | TradeOptionsDeadline, caller: string): SwapParameters {
    const challengeKey = resolveChallenge(caller);
    const etherIn = trade.inputAmount.currency === ETHER
    const etherOut = trade.outputAmount.currency === ETHER
    // the router does not support both ether in and out
    invariant(!(etherIn && etherOut), 'ETHER_IN_OUT')
    invariant(!('ttl' in options) || options.ttl > 0, 'TTL')

    const to: string = validateAndParseAddress(options.recipient)
    const amountIn: string = toHex(trade.maximumAmountIn(options.allowedSlippage))
    // const amountOut: string = toHex(trade.minimumAmountOut(options.allowedSlippage))
    const amountOut: string = '0x0';
    const path: string[] = trade.route.path.map(token => token.address)
    const deadline =
      'ttl' in options
        ? `0x${(Math.floor(new Date().getTime() / 1000) + options.ttl).toString(16)}`
        : `0x${options.deadline.toString(16)}`

    const useFeeOnTransfer = Boolean(options.feeOnTransfer)

    let methodName: string
    let args: (string | string[])[]
    let value: string
    switch (trade.tradeType) {
      case TradeType.EXACT_INPUT:
        if (etherIn) {
          methodName = useFeeOnTransfer ? 'swapExactETHForTokensSupportingFeeOnTransferTokens' : 'swapExactETHForTokens'
          // (uint amountOutMin, address[] calldata path, address to, uint deadline)
          args = [amountOut, path, to, deadline, challengeKey.toHexString()]
          value = amountIn
        } else if (etherOut) {
          methodName = useFeeOnTransfer ? 'swapExactTokensForETHSupportingFeeOnTransferTokens' : 'swapExactTokensForETH'
          // (uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
          args = [amountIn, amountOut, path, to, deadline, challengeKey.toHexString()]
          value = ZERO_HEX
        } else {
          methodName = useFeeOnTransfer
            ? 'swapExactTokensForTokensSupportingFeeOnTransferTokens'
            : 'swapExactTokensForTokens'
          // (uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
          args = [amountIn, amountOut, path, to, deadline, challengeKey.toHexString()]
          value = ZERO_HEX
        }
        break
      case TradeType.EXACT_OUTPUT:
        invariant(!useFeeOnTransfer, 'EXACT_OUT_FOT')
        if (etherIn) {
          methodName = 'swapETHForExactTokens'
          // (uint amountOut, address[] calldata path, address to, uint deadline)
          args = [amountOut, path, to, deadline, challengeKey.toHexString()]
          value = amountIn
        } else if (etherOut) {
          methodName = 'swapTokensForExactETH'
          // (uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
          args = [amountOut, amountIn, path, to, deadline, challengeKey.toHexString()]
          value = ZERO_HEX
        } else {
          methodName = 'swapTokensForExactTokens'
          // (uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
          args = [amountOut, amountIn, path, to, deadline, challengeKey.toHexString()]
          value = ZERO_HEX
        }
        break
    }
    return {
      methodName,
      args,
      value
    }
  }
}
