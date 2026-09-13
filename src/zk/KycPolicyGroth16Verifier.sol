// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract KycPolicyGroth16Verifier {
    // Scalar field size
    uint256 constant r = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax = 17539168658673448164656617594468319653310490291884511660011322937528778806669;
    uint256 constant alphay = 18581216562833894519796525604256005666591804501524121282405467727996972245502;
    uint256 constant betax1 = 11572187453947501314657480315091373943606224703827346805484709303633711365314;
    uint256 constant betax2 = 10359417082215856039683057821018840021361763893383554537161985361245647418999;
    uint256 constant betay1 = 4083699593736935692145917399271362334231938458809144295707015189207839592521;
    uint256 constant betay2 = 9599597051815851304839890512901488760683616937032227281445613123692306387941;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 19806499809450026850207514885208143887720122495333619569971758869955625270857;
    uint256 constant deltax2 = 20798971276233209256492293340528112865571286570559805767266469856198182767329;
    uint256 constant deltay1 = 16151700670914420480504259486076689876639465578687704141412338294773057826789;
    uint256 constant deltay2 = 4804010656233829728614820058595608973115938527659113870964075689018980643871;

    uint256 constant IC0x = 7451099967807491470029735154250209072645552612732003371836902004756363390615;
    uint256 constant IC0y = 15552141413738648285706296617106019455441415054348531191336430850766709873788;

    uint256 constant IC1x = 15352528639392111384486077088109222284260219110545798408462812686726168769353;
    uint256 constant IC1y = 12907594858185664230680592426481456690272503169084370579604610371242041138149;

    uint256 constant IC2x = 2596307041923480019565958192774103393820603724848397133150221841681849332215;
    uint256 constant IC2y = 15523764143681259817585595330185686913453499288956383386955221418792547971329;

    uint256 constant IC3x = 9059438815684189443207861648581355133326370273292056887287574889026164863402;
    uint256 constant IC3y = 16042890048487017556395072150595492135139363433365310540273721067712803745762;

    uint256 constant IC4x = 19288325909756637762493297798847604283056330219813481795965212566525002311569;
    uint256 constant IC4y = 10424318836122951271688782760735894847259541140628750493136041704377040358819;

    uint256 constant IC5x = 13716231647321579912681098814512361333613356709748027901549838973673508136030;
    uint256 constant IC5y = 19470593400916351404959513717447589020560337573645376223053754713478734822265;

    uint256 constant IC6x = 20544649741404228148416435694584066799940126768255674355161519767397548333839;
    uint256 constant IC6y = 6990890734144931843669289724651743470418944952560730274365934681541488526043;

    uint256 constant IC7x = 8827588406587641435667775023864745773460845767617340747425383447229343719851;
    uint256 constant IC7y = 10998036835553323862266902497635126376273661580925648529548013439080059432438;

    uint256 constant IC8x = 2300945529316694578148825240822807048609843223908551812663911832339844123691;
    uint256 constant IC8y = 2612852647869790665317663059476104834130407024949581101974231570205848368174;

    uint256 constant IC9x = 20906372995889149476943488412419590020388706180043979415318943868824694877832;
    uint256 constant IC9y = 18233804190864297178954975908308041518966039228302242475055283062195330679420;

    uint256 constant IC10x = 14665310317586080336390489242449451139921530553753583444095297102026074890563;
    uint256 constant IC10y = 8504715857827887756816154289295578192950136356115754212794288809904592934197;

    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[10] calldata _pubSignals
    ) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))

                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)

                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
            return(0, 0x20)
        }
    }
}
